import { useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { callFunction, failure, functionUrl } from "@/lib/account"
import { checkHealth } from "@/lib/hermes"
import {
  db,
  deleteProfile,
  pickBotId,
  DEFAULT_PROFILE,
  updateProfile,
  type Profile,
} from "@/lib/db"
import { isNative, SITE_URL } from "@/lib/native"
import { inboxKey, inboxPublic } from "@/lib/sync"
import { inboxFingerprint, openFromInbox, toBase32, type SealedToInbox } from "@/lib/vault"

/**
 * The bot registry (`netlify/lib/registry.ts`): Gots plugins register their Hermes profiles there,
 * sealed to the account's inbox, and every device turns the records into bots.
 */

interface RegistryBot {
  hostId: string
  keyId: string
  sealed: SealedToInbox
  enabled: boolean
  adopts?: string
  seen?: { at: number; pluginVersion?: string }
}

/** What a plugin seals for the app (`record` in `plugin/link.py`). */
interface BotRecord {
  name: string
  profile: string
  baseUrl: string
  apiKey: string
  pluginVersion?: string
}

/** The plugin checks in every 10 minutes, so two missed check-ins and a margin mean it's gone. */
const ONLINE_MS = 25 * 60_000
/** How soon an unreachable bot is checked again while a screen watches it. */
const RETRY_MS = 5000

export function isOnline(profile: Profile, now = Date.now()) {
  return Boolean(profile.seenAt && now - profile.seenAt < ONLINE_MS)
}

/** Where the plugin reaches the registry: this site, or the one the Android app was built for. */
export function siteUrl() {
  return isNative ? SITE_URL : window.location.origin
}

function registryUrl(route: string, id?: string) {
  return functionUrl("registry", id ? { route, id } : { route })
}

async function send(method: string, route: string, id?: string, body?: unknown) {
  const response = await callFunction(method, registryUrl(route, id), body)
  if (!response.ok) throw await failure(response)
  return response
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

export interface LinkCode {
  code: string
  expiresAt: number
}

/**
 * A new link code. Only the code's id and the secret's hash reach the registry, and the code carries
 * the inbox key's fingerprint, so the plugin can tell the key it's handed is this account's.
 */
export async function mintLinkCode(): Promise<LinkCode> {
  const publicKey = inboxPublic()
  if (!publicKey) throw new Error("Turn on sync first.")
  const codeId = toBase32(crypto.getRandomValues(new Uint8Array(5)))
  const secret = toBase32(crypto.getRandomValues(new Uint8Array(10)))
  const fingerprint = toBase32(await inboxFingerprint(publicKey))
  const response = await send("POST", "codes", undefined, {
    codeId,
    secretHash: await sha256Hex(secret),
  })
  const { expiresAt } = (await response.json()) as { expiresAt: number }
  return { code: `mk_${codeId}-${secret}-${fingerprint}`, expiresAt }
}

/** The commands that install the plugin and link a profile with `code`. */
export function linkCommands(code: string) {
  return `hermes plugins install thehaseebahmed/memento/plugin --enable
hermes gots link ${code} --site ${siteUrl()}`
}

export function linkProfileCommand(code: string) {
  return `hermes -p <name> gots link ${code} --site ${siteUrl()}`
}

/** Turns a bot on or off on every device. */
export async function setBotEnabled(profile: Profile, enabled: boolean) {
  await db.profiles.update(profile.id, { disabled: !enabled })
  try {
    await send("PATCH", "bots", await registryId(profile), { enabled })
  } catch (error) {
    await db.profiles.update(profile.id, { disabled: profile.disabled })
    throw error
  }
}

/** Unlinks the host that registered `profile`, with every bot it registered. */
export async function removeHost(hostId: string) {
  await send("DELETE", "hosts", hostId)
  for (const profile of await db.profiles.filter((p) => p.hostId === hostId).toArray()) {
    await deleteProfile(profile.id, { last: true })
  }
}

/** The registry id behind a bot: its own id, unless it adopted a bot added by hand. */
const registryIds = new Map<string, string>()

async function registryId(profile: Profile) {
  if (!registryIds.has(profile.id)) await syncRegistry()
  return registryIds.get(profile.id) ?? profile.id
}

function serverKey(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

/** The plugin hands over the server's URL; the app's bots point at its `/v1`. */
function apiUrl(baseUrl: string) {
  return `${serverKey(baseUrl)}/v1`
}

let running: Promise<void> | undefined

/**
 * Brings the bots in line with the registry: records become bots (taking over a bot added by hand
 * for the same server, so its chats stay), changes land in place, and bots whose host left go.
 * A failed read changes nothing, so an outage never empties the list.
 */
export function syncRegistry(): Promise<void> {
  running ??= pull().finally(() => {
    running = undefined
  })
  return running
}

async function pull() {
  const inbox = await inboxKey()
  if (!inbox) return
  const response = await send("GET", "bots")
  const { bots } = (await response.json()) as { bots: Record<string, RegistryBot> }
  const present = new Set<string>()
  for (const [botId, record] of Object.entries(bots)) {
    let id = record.adopts ?? botId
    registryIds.set(id, botId)
    present.add(id)
    if (record.keyId !== inbox.keyId) continue
    let value: BotRecord
    try {
      value = await openFromInbox<BotRecord>(
        inbox.key,
        record.sealed,
        `memento:${inbox.userId}:bot:${botId}`,
      )
    } catch {
      // Sealed to a key this device doesn't hold yet; the host re-seals on its next check-in.
      continue
    }
    const local = {
      disabled: !record.enabled || undefined,
      seenAt: record.seen?.at,
      pluginVersion: record.seen?.pluginVersion ?? value.pluginVersion,
    }
    const profiles = await db.profiles.toArray()
    if (!record.adopts && !profiles.some((p) => p.id === botId)) {
      const manual = profiles.find(
        (p) =>
          !p.hostId &&
          p.apiKey === value.apiKey &&
          serverKey(p.baseUrl) === serverKey(value.baseUrl),
      )
      if (manual) {
        await send("PATCH", "bots", botId, { adopts: manual.id })
        present.delete(id)
        id = manual.id
        registryIds.delete(botId)
        registryIds.set(id, botId)
        present.add(id)
      }
    }
    const existing = profiles.find((p) => p.id === id)
    const baseUrl = apiUrl(value.baseUrl)
    if (existing) {
      if (
        existing.baseUrl !== baseUrl ||
        existing.apiKey !== value.apiKey ||
        existing.hostId !== record.hostId
      ) {
        await updateProfile(id, { baseUrl, apiKey: value.apiKey, hostId: record.hostId })
      }
      await db.profiles.update(id, local)
      continue
    }
    // Removed in this app, and its host's removal still on its way.
    if (await db.tombstones.get(`bot:${id}`)) continue
    const now = Date.now()
    await db.profiles.add({
      ...DEFAULT_PROFILE,
      id,
      name: value.name,
      baseUrl,
      apiKey: value.apiKey,
      hostId: record.hostId,
      botId: pickBotId(profiles.map((p) => p.botId)),
      createdAt: now,
      updatedAt: now,
      ...local,
    })
  }
  for (const profile of await db.profiles.toArray()) {
    if (profile.hostId && !present.has(profile.id)) {
      await deleteProfile(profile.id, { last: true })
    }
  }
}

/** Whether this device reaches the bot's server, checked again when its address or key changes. */
export function useReachable(profile: Profile | undefined) {
  const [state, setState] = useState<{ key: string; ok: boolean }>()
  const [tick, setTick] = useState(0)
  const baseUrl = profile && !profile.disabled ? profile.baseUrl : undefined
  const apiKey = profile?.apiKey ?? ""
  const key = baseUrl === undefined ? "" : connectionKey({ baseUrl, apiKey })
  useEffect(() => {
    if (baseUrl === undefined) return
    let cancelled = false
    let timer: number | undefined
    checkHealth({ baseUrl, apiKey }).then(
      () => !cancelled && setState({ key, ok: true }),
      () => {
        if (cancelled) return
        setState({ key, ok: false })
        // Often a gateway restart away, so look again while the screen is open.
        timer = window.setTimeout(() => setTick((n) => n + 1), RETRY_MS)
      },
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [key, baseUrl, apiKey, tick])
  return state?.key === key && key ? state.ok : undefined
}
