/**
 * The bot registry: Memento plugins register their Hermes profiles here, and the app reads them back.
 * A plugin joins an account by claiming a link code the app minted, which hands it a host token.
 * Bot records arrive sealed to the account's inbox key (`vault.ts`), so this only sees ids, flags
 * and times; chats never pass through here.
 */

import type { FcmSender, PushKind } from "./fcm.ts"

export interface RegistryStore {
  getWithMetadata(
    key: string,
    options: { type: "json" },
  ): Promise<{ data: unknown; etag?: string } | null>
  setJSON(
    key: string,
    data: unknown,
    options?: { onlyIfMatch: string } | { onlyIfNew: boolean },
  ): Promise<{ modified: boolean; etag?: string }>
  delete(key: string): Promise<void>
  list(options: { prefix: string }): Promise<{ blobs: { key: string }[] }>
}

export interface Inbox {
  keyId: string
  publicKey: string
}

export type Caller = { kind: "user"; userId: string } | { kind: "host"; token: string } | null

interface Code {
  userId: string
  secretHash: string
  expiresAt: number
  claims: number
  failures: number
}

interface Host {
  tokenHash: string
  createdAt: number
}

interface TokenEntry {
  userId: string
  hostId: string
}

export interface BotRecord {
  hostId: string
  keyId: string
  sealed: { v: 1; epk: string; iv: string; ct: string }
  enabled: boolean
  /** The manually added bot this one took over, so its chats stay with it on every device. */
  adopts?: string
  createdAt: number
  updatedAt: number
}

/** An Android install that wants pushes, as its app registered it. */
interface Device {
  token: string
  updatedAt: number
}

interface Seen {
  at: number
  pluginVersion?: string
}

/** A code works for 30 minutes and up to 20 profiles, so one covers a sitting. */
export const CODE_TTL_MS = 30 * 60_000
const MAX_CLAIMS = 20
/** Wrong secrets for a known code id before the code is burned. */
const MAX_FAILURES = 10
const MAX_BYTES = 16 * 1024
const MAX_DEVICES = 10
/** A host may ask for one push a second; the plugin throttles harder, this bounds a misbehaving one. */
const PUSH_GAP_MS = 1000
/** A person tapping a test button. */
const TEST_GAP_MS = 3000
const PUSH_KINDS: readonly string[] = ["approval", "question", "plan"]
const DEVICE_TOKEN = /^\S{20,4096}$/

const CODE_ID = /^[0-9A-HJKMNP-TV-Z]{8}$/
const SECRET = /^[0-9A-HJKMNP-TV-Z]{16}$/
const HASH = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const KEY_ID = /^[0-9a-f]{16}$/
const B64 = /^[A-Za-z0-9+/]+={0,2}$/

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function error(message: string, status: number) {
  return json({ error: message }, status)
}

export async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `mh_${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text()
  if (raw.length > MAX_BYTES) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

async function read<T>(store: RegistryStore, key: string) {
  const entry = await store.getWithMetadata(key, { type: "json" })
  return entry ? { data: entry.data as T, etag: entry.etag } : null
}

/** Read, change and write back on the etag read, retrying when someone wrote in between. */
async function update<T>(
  store: RegistryStore,
  key: string,
  change: (current: T | null) => T | null,
): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await read<T>(store, key)
    const next = change(current?.data ?? null)
    if (next === null) return current?.data ?? null
    const result = await store.setJSON(
      key,
      next,
      current?.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true },
    )
    if (result.modified) return next
  }
  throw new Error("Changed too often")
}

function validSealed(value: unknown): value is BotRecord["sealed"] {
  if (!value || typeof value !== "object") return false
  const { v, epk, iv, ct } = value as Record<string, unknown>
  return (
    v === 1 &&
    [epk, iv, ct].every((part) => typeof part === "string" && part.length > 0 && B64.test(part))
  )
}

async function deleteHost(store: RegistryStore, userId: string, hostId: string) {
  const host = await read<Host>(store, `users/${userId}/hosts/${hostId}`)
  if (host) await store.delete(`tokens/${host.data.tokenHash}`)
  for (const { key } of (await store.list({ prefix: `users/${userId}/bots/` })).blobs) {
    const bot = await read<BotRecord>(store, key)
    if (bot?.data.hostId !== hostId) continue
    const botId = key.slice(key.lastIndexOf("/") + 1)
    await store.delete(key)
    await store.delete(`users/${userId}/seen/${botId}`)
  }
  await store.delete(`users/${userId}/pushed/${hostId}`)
  await store.delete(`users/${userId}/hosts/${hostId}`)
}

export interface RegistryContext {
  store: RegistryStore
  caller: Caller
  /** The account's inbox from its vault document, if sync is set up and the inbox published. */
  inbox: (userId: string) => Promise<Inbox | undefined>
  /** Origins the app runs on, which the plugin adds to Hermes's CORS list. */
  origins: string[]
  /** Sends to Android installs; null when no Firebase service account is configured. */
  fcm?: FcmSender | null
  now?: number
}

export async function handleRegistry(req: Request, ctx: RegistryContext) {
  const { store, caller } = ctx
  const now = ctx.now ?? Date.now()
  const url = new URL(req.url)
  const route = url.searchParams.get("route") ?? ""
  const id = url.searchParams.get("id") ?? ""
  const op = `${req.method} ${route}`

  if (op === "POST claim") {
    const input = await body(req)
    const codeId = input?.codeId
    const secret = input?.secret
    if (typeof codeId !== "string" || !CODE_ID.test(codeId)) return error("Unknown code", 404)
    if (typeof secret !== "string" || !SECRET.test(secret)) return error("Unknown code", 404)
    const code = await read<Code>(store, `codes/${codeId}`)
    if (!code) return error("Unknown code", 404)
    const { data } = code
    if (now > data.expiresAt || data.claims >= MAX_CLAIMS || data.failures >= MAX_FAILURES) {
      return error("This link code has expired. Copy a new one from Memento.", 410)
    }
    if ((await sha256(secret)) !== data.secretHash) {
      await update<Code>(store, `codes/${codeId}`, (c) => c && { ...c, failures: c.failures + 1 })
      return error("Unknown code", 404)
    }
    let used = false
    await update<Code>(store, `codes/${codeId}`, (c) => {
      if (c && c.claims < MAX_CLAIMS) return { ...c, claims: c.claims + 1 }
      used = true
      return null
    })
    if (used) return error("This link code has expired. Copy a new one from Memento.", 410)
    const inbox = await ctx.inbox(data.userId)
    if (!inbox) return error("Turn on sync in Memento first.", 409)
    const hostId = crypto.randomUUID()
    const token = randomToken()
    const tokenHash = await sha256(token)
    await store.setJSON(`tokens/${tokenHash}`, { userId: data.userId, hostId } satisfies TokenEntry)
    await store.setJSON(`users/${data.userId}/hosts/${hostId}`, {
      tokenHash,
      createdAt: now,
    } satisfies Host)
    return json({ userId: data.userId, hostId, token, inbox, origins: ctx.origins })
  }

  if (caller?.kind === "host") {
    const entry = await read<TokenEntry>(store, `tokens/${await sha256(caller.token)}`)
    if (!entry) return error("This host isn't linked", 401)
    const { userId, hostId } = entry.data
    const botKey = `users/${userId}/bots/${id}`

    if (op === "GET inbox") {
      const inbox = await ctx.inbox(userId)
      return inbox ? json({ userId, inbox }) : error("No inbox", 404)
    }

    if (op === "PUT bots") {
      if (!ID.test(id)) return error("Invalid bot id", 400)
      const input = await body(req)
      if (typeof input?.keyId !== "string" || !KEY_ID.test(input.keyId)) {
        return error("Invalid key id", 400)
      }
      if (!validSealed(input.sealed)) return error("Invalid record", 400)
      const { keyId, sealed } = input as { keyId: string; sealed: BotRecord["sealed"] }
      let foreign = false
      await update<BotRecord>(store, botKey, (current) => {
        if (current && current.hostId !== hostId) {
          foreign = true
          return null
        }
        return {
          hostId,
          keyId,
          sealed,
          enabled: current?.enabled ?? true,
          ...(current?.adopts ? { adopts: current.adopts } : {}),
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        }
      })
      if (foreign) return error("Another host registered this bot", 403)
      return json({ ok: true })
    }

    if (op === "DELETE bots") {
      if (!ID.test(id)) return error("Invalid bot id", 400)
      const current = await read<BotRecord>(store, botKey)
      if (current && current.data.hostId !== hostId) return error("Not this host's bot", 403)
      await store.delete(botKey)
      await store.delete(`users/${userId}/seen/${id}`)
      return new Response(null, { status: 204 })
    }

    if (op === "POST seen") {
      const input = await body(req)
      const ids = input?.bots
      if (
        !Array.isArray(ids) ||
        ids.length > 50 ||
        !ids.every((b) => typeof b === "string" && ID.test(b))
      ) {
        return error("Invalid bots", 400)
      }
      const pluginVersion =
        typeof input?.pluginVersion === "string" ? input.pluginVersion.slice(0, 32) : undefined
      const bots: Record<string, { enabled: boolean } | null> = {}
      for (const botId of ids as string[]) {
        const record = await read<BotRecord>(store, `users/${userId}/bots/${botId}`)
        if (!record || record.data.hostId !== hostId) {
          // Gone (or never published): the plugin publishes it again.
          bots[botId] = null
          continue
        }
        await store.setJSON(`users/${userId}/seen/${botId}`, {
          at: now,
          pluginVersion,
        } satisfies Seen)
        bots[botId] = { enabled: record.data.enabled }
      }
      const inbox = await ctx.inbox(userId)
      return json({ keyId: inbox?.keyId ?? null, bots })
    }

    if (op === "POST push") {
      const input = await body(req)
      const kind = input?.kind
      const sessionId = input?.session_id
      if (typeof kind !== "string" || !PUSH_KINDS.includes(kind)) return error("Invalid kind", 400)
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) {
        return error("Invalid session", 400)
      }
      // Devices that have the app open already know.
      const skip = Array.isArray(input?.skip)
        ? new Set(input.skip.filter((d): d is string => typeof d === "string").slice(0, 50))
        : new Set<string>()
      if (!ctx.fcm) return error("Push isn't set up on this site", 503)
      const gapKey = `users/${userId}/pushed/${hostId}`
      const last = await read<{ at: number }>(store, gapKey)
      if (last && now - last.data.at < PUSH_GAP_MS) return error("Slow down", 429)
      await store.setJSON(gapKey, { at: now })
      let sent = 0
      let failed = 0
      let skipped = 0
      for (const { key } of (await store.list({ prefix: `users/${userId}/devices/` })).blobs) {
        const deviceId = key.slice(key.lastIndexOf("/") + 1)
        if (skip.has(deviceId)) {
          skipped++
          continue
        }
        const device = await read<Device>(store, key)
        if (!device) continue
        const result = await ctx.fcm.send(device.data.token, kind as PushKind, sessionId)
        if (result === "ok") sent++
        else {
          failed++
          if (result === "gone") await store.delete(key)
        }
      }
      return json({ sent, failed, skipped })
    }

    if (op === "DELETE host") {
      await deleteHost(store, userId, hostId)
      return new Response(null, { status: 204 })
    }

    return error("Not found", 404)
  }

  if (caller?.kind !== "user") return error("Sign in first", 401)
  const { userId } = caller

  if (op === "POST codes") {
    const input = await body(req)
    const codeId = input?.codeId
    const secretHash = input?.secretHash
    if (typeof codeId !== "string" || !CODE_ID.test(codeId)) return error("Invalid code id", 400)
    if (typeof secretHash !== "string" || !HASH.test(secretHash)) return error("Invalid hash", 400)
    // The plugin needs an inbox to seal its record to, so only an account with sync set up links.
    if (!(await ctx.inbox(userId))) return error("Turn on sync first.", 409)
    const expiresAt = now + CODE_TTL_MS
    const result = await store.setJSON(
      `codes/${codeId}`,
      { userId, secretHash, expiresAt, claims: 0, failures: 0 } satisfies Code,
      { onlyIfNew: true },
    )
    if (!result.modified) return error("Code id taken", 409)
    return json({ expiresAt })
  }

  if (op === "GET bots") {
    const bots: Record<string, BotRecord & { seen?: Seen }> = {}
    for (const { key } of (await store.list({ prefix: `users/${userId}/bots/` })).blobs) {
      const record = await read<BotRecord>(store, key)
      if (!record) continue
      const botId = key.slice(key.lastIndexOf("/") + 1)
      const seen = await read<Seen>(store, `users/${userId}/seen/${botId}`)
      bots[botId] = { ...record.data, ...(seen ? { seen: seen.data } : {}) }
    }
    return json({ bots })
  }

  if (op === "PATCH bots") {
    if (!ID.test(id)) return error("Invalid bot id", 400)
    const input = await body(req)
    if (!input) return error("Invalid JSON", 400)
    const { enabled, adopts } = input
    if (enabled !== undefined && typeof enabled !== "boolean") return error("Invalid enabled", 400)
    if (
      adopts !== undefined &&
      adopts !== null &&
      !(typeof adopts === "string" && ID.test(adopts))
    ) {
      return error("Invalid adopts", 400)
    }
    let missing = false
    const record = await update<BotRecord>(store, `users/${userId}/bots/${id}`, (current) => {
      if (!current) {
        missing = true
        return null
      }
      const { adopts: _previous, ...rest } = current
      const keep = adopts === undefined ? current.adopts : (adopts ?? undefined)
      return {
        ...rest,
        enabled: enabled ?? current.enabled,
        ...(keep ? { adopts: keep } : {}),
        updatedAt: now,
      }
    })
    if (missing || !record) return error("Not found", 404)
    return json({ bot: record })
  }

  if (op === "POST devices") {
    const input = await body(req)
    const token = input?.token
    if (!ID.test(id)) return error("Invalid device id", 400)
    if (typeof token !== "string" || !DEVICE_TOKEN.test(token)) return error("Invalid token", 400)
    const prefix = `users/${userId}/devices/`
    const known = (await store.list({ prefix })).blobs.map((b) => b.key)
    if (!known.includes(`${prefix}${id}`) && known.length >= MAX_DEVICES) {
      return error("Too many devices", 409)
    }
    await store.setJSON(`${prefix}${id}`, { token, updatedAt: now } satisfies Device)
    return json({ ok: true })
  }

  if (op === "POST push-test") {
    if (!ID.test(id)) return error("Invalid device id", 400)
    if (!ctx.fcm) return error("Push isn't set up on this site", 503)
    const device = await read<Device>(store, `users/${userId}/devices/${id}`)
    if (!device) return error("This device isn't registered for push", 404)
    const gapKey = `users/${userId}/tested`
    const last = await read<{ at: number }>(store, gapKey)
    if (last && now - last.data.at < TEST_GAP_MS) return error("Slow down", 429)
    await store.setJSON(gapKey, { at: now })
    const reason = await ctx.fcm.test(device.data.token)
    return reason ? error(reason, 502) : json({ ok: true })
  }

  if (op === "DELETE devices") {
    if (!ID.test(id)) return error("Invalid device id", 400)
    await store.delete(`users/${userId}/devices/${id}`)
    return new Response(null, { status: 204 })
  }

  if (op === "DELETE hosts") {
    if (!/^[0-9a-f-]{36}$/.test(id)) return error("Invalid host id", 400)
    await deleteHost(store, userId, id)
    return new Response(null, { status: 204 })
  }

  return error("Not found", 404)
}
