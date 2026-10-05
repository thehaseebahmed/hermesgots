import { useSyncExternalStore } from "react"
import { liveQuery } from "dexie"

import {
  deleteDoc,
  getDoc,
  loadAccount,
  putDoc,
  signOut as identitySignOut,
  watchAccount,
  type Account,
} from "@/lib/account"
import { checkHealth, HermesError, mergeChatList } from "@/lib/hermes"
import {
  DEFAULT_PROFILE,
  db,
  deleteConversation,
  deleteProfile,
  getSettings,
  saveSettings,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { mergeDocs, type Doc, type Entry } from "@/lib/merge"
import {
  PrfUnsupportedError,
  generateDataKey,
  hasPasskeys,
  lockDown,
  newRecoveryCode,
  newVault,
  passkeyWrapper,
  recoveryWrapper,
  seal,
  unlockWithPasskey,
  unlockWithRecoveryCode,
  unseal,
  type Sealed,
  type Vault,
} from "@/lib/vault"

/**
 * Syncs bots and the chat list (titles, Hermes session ids and context use, not messages). Each
 * bot's chat list lives with the Memento plugin on its own Hermes server; without the plugin it falls
 * back to the Netlify function, like bots. Everything sent there is sealed with the account's data
 * key, and each document's associated data names its owner and slot, so the server can't swap one
 * document for another.
 */

type BotValue = Omit<Profile, "id" | "updatedAt" | "pluginChats">
type ChatValue = Pick<
  Conversation,
  | "title"
  | "titleEdited"
  | "hermesSessionId"
  | "createdAt"
  | "updatedAt"
  | "contextTokens"
  | "contextApproximate"
>

/**
 * Where a bot's chat list lives: its Hermes server's Memento plugin, or the fallback.
 * `unreachable`: the bot has the plugin, but its server didn't answer the last sync.
 */
export type ChatStore = "plugin" | "fallback" | "unreachable"

export interface SyncState {
  account: Account
  vault: "unknown" | "missing" | "locked" | "unlocked"
  passkeys: boolean
  syncing: boolean
  error?: string
  syncedAt?: number
  /** By profile id; missing until the bot's server has answered. */
  chatStores: Record<string, ChatStore>
}

let state: SyncState = {
  account: { status: "loading" },
  vault: "unknown",
  passkeys: false,
  syncing: false,
  chatStores: {},
}
const listeners = new Set<() => void>()

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export function useSyncState() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

let remoteVault: { vault: Vault; etag?: string } | null = null
/** The extractable data key, held in memory only right after an unlock, to add more passkeys. */
let sessionKey: CryptoKey | undefined

function userId() {
  return state.account.status === "signed-in" ? state.account.user.id : undefined
}

async function localKey() {
  const id = userId()
  const stored = await db.vault.get("key")
  return stored && stored.userId === id ? stored.key : undefined
}

async function refreshVault() {
  const doc = await getDoc<Vault>("vault")
  remoteVault = doc && { vault: doc.data, etag: doc.etag }
  const unlocked = Boolean(doc && (await localKey()))
  setState({
    vault: !doc ? "missing" : unlocked ? "unlocked" : "locked",
    passkeys: Boolean(doc && hasPasskeys(doc.data)),
  })
}

async function keep(dataKey: CryptoKey) {
  const id = userId()
  if (!id) throw new Error("Sign in first.")
  sessionKey = dataKey
  await db.vault.put({ id: "key", userId: id, key: await lockDown(dataKey) })
  setState({ vault: "unlocked", error: undefined })
  void syncNow()
}

function passkeyUser() {
  if (state.account.status !== "signed-in") throw new Error("Sign in first.")
  const { user } = state.account
  const name = user.email ?? user.name ?? "Memento"
  return { id: user.id, name, displayName: user.name ?? name }
}

/** First-time setup: a new data key, wrapped by a passkey when it can be, and a recovery code. */
export async function setUpSync() {
  const dataKey = await generateDataKey()
  const vault = newVault()
  let passkey = true
  try {
    vault.wrappers.push(await passkeyWrapper(dataKey, vault, passkeyUser()))
  } catch (error) {
    if (!(error instanceof PrfUnsupportedError)) throw error
    passkey = false
  }
  const recoveryCode = newRecoveryCode()
  vault.wrappers.push(await recoveryWrapper(dataKey, recoveryCode))
  if (!(await putDoc("vault", vault))) {
    await refreshVault()
    throw new Error("Sync was already set up from another device. Unlock it instead.")
  }
  await refreshVault()
  await keep(dataKey)
  return { recoveryCode, passkey }
}

export async function unlockSyncWithPasskey() {
  if (!remoteVault) throw new Error("Sync isn't set up yet.")
  await keep(await unlockWithPasskey(remoteVault.vault))
}

export async function unlockSyncWithRecoveryCode(code: string) {
  if (!remoteVault) throw new Error("Sync isn't set up yet.")
  await keep(await unlockWithRecoveryCode(remoteVault.vault, code))
}

/** Adds this device's passkey. Needs the key in memory, or another passkey to unwrap it again. */
export async function addPasskey() {
  if (!remoteVault) throw new Error("Sync isn't set up yet.")
  const dataKey = sessionKey ?? (await unlockWithPasskey(remoteVault.vault))
  sessionKey = dataKey
  for (let attempt = 0; attempt < 3; attempt++) {
    const { vault, etag } = remoteVault
    const wrapper = await passkeyWrapper(dataKey, vault, passkeyUser())
    if (await putDoc("vault", { ...vault, wrappers: [...vault.wrappers, wrapper] }, etag)) {
      await refreshVault()
      return
    }
    await refreshVault()
  }
  throw new Error("Couldn't save the passkey. Try again.")
}

export function canAddPasskey() {
  return Boolean(sessionKey) || state.passkeys
}

export async function signOut() {
  await identitySignOut().catch(() => undefined)
  sessionKey = undefined
  remoteVault = null
  await db.vault.clear()
  setState({
    account: { status: "signed-out" },
    vault: "unknown",
    passkeys: false,
    error: undefined,
  })
}

/** Forgets the key on this device, for "Clear local data". */
export function forgetLocalKey() {
  sessionKey = undefined
  setState({ vault: state.vault === "unlocked" ? "locked" : state.vault })
}

// Documents

async function readDoc<T>(key: CryptoKey, name: string) {
  const doc = await getDoc<Sealed>(name)
  if (!doc) return { entries: {} as Doc<T>, etag: undefined }
  const entries = await unseal<Doc<T>>(key, doc.data, `memento:${userId()}:${name}`)
  return { entries, etag: doc.etag }
}

async function writeDoc<T>(key: CryptoKey, name: string, entries: Doc<T>, etag?: string) {
  return putDoc(name, await seal(key, entries, `memento:${userId()}:${name}`), etag)
}

/**
 * Pulls a document, merges it with this device's records and writes it back if this device had
 * anything newer. Retries when another device wrote in between.
 */
async function syncDoc<T>(
  key: CryptoKey,
  name: string,
  local: (remote: Doc<T>) => Promise<Doc<T>>,
  apply: (pull: [string, Entry<T>][], remote: Doc<T>) => Promise<void>,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await readDoc<T>(key, name)
    const { merged, pull, changed } = mergeDocs(remote.entries, await local(remote.entries))
    if (changed && !(await writeDoc(key, name, merged, remote.etag))) continue
    await apply(pull, remote.entries)
    return merged
  }
  throw new Error("Another device kept changing the same data. Try again.")
}

function botValue({
  id: _id,
  updatedAt: _updatedAt,
  pluginChats: _pluginChats,
  ...value
}: Profile): BotValue {
  return value
}

async function localBots(): Promise<Doc<BotValue>> {
  const doc: Doc<BotValue> = {}
  for (const profile of await db.profiles.toArray()) {
    doc[profile.id] = { at: profile.updatedAt, value: botValue(profile) }
  }
  for (const tombstone of await db.tombstones.where("id").startsWith("bot:").toArray()) {
    doc[tombstone.profileId] = { at: tombstone.deletedAt, deleted: true }
  }
  return doc
}

/** The bot a fresh install seeds, untouched: a new device drops it for the synced ones. */
async function pristineSeed() {
  const profiles = await db.profiles.toArray()
  if (profiles.length !== 1) return undefined
  const [profile] = profiles
  const untouched =
    profile.updatedAt === profile.createdAt &&
    profile.name === DEFAULT_PROFILE.name &&
    profile.baseUrl === DEFAULT_PROFILE.baseUrl &&
    profile.apiKey === DEFAULT_PROFILE.apiKey &&
    profile.model === DEFAULT_PROFILE.model &&
    (await db.conversations.where("profileId").equals(profile.id).count()) === 0
  return untouched ? profile : undefined
}

/** True while the only bot is the untouched seed, so first-run setup still has work to do. */
export async function needsBotSetup() {
  return Boolean(await pristineSeed())
}

async function syncBots(key: CryptoKey) {
  const seed = await pristineSeed()
  const hasBots = (doc: Doc<BotValue>) => Object.values(doc).some((entry) => !entry.deleted)
  const merged = await syncDoc<BotValue>(
    key,
    "bots",
    async (remote) => {
      const doc = await localBots()
      if (seed && hasBots(remote)) delete doc[seed.id]
      return doc
    },
    async (pull, remote) => {
      for (const [id, entry] of pull) {
        if (entry.deleted) {
          if (await db.profiles.get(id)) await deleteProfile(id, { remote: true })
        } else if (entry.value) {
          await db.transaction("rw", db.profiles, db.tombstones, async () => {
            const { pluginChats } = (await db.profiles.get(id)) ?? {}
            await db.profiles.put({ ...entry.value!, id, updatedAt: entry.at, pluginChats })
            await db.tombstones.delete(`bot:${id}`)
          })
        }
      }
      if (seed && hasBots(remote)) await deleteProfile(seed.id, { remote: true })
    },
  )
  // Pushed deletions live on in the merged document; their chat lists can go.
  for (const tombstone of await db.tombstones.where("id").startsWith("bot:").toArray()) {
    if (merged[tombstone.profileId]?.at !== tombstone.deletedAt) continue
    await deleteDoc(`chats/${tombstone.profileId}`).catch(() => undefined)
    await db.tombstones.delete(tombstone.id)
  }
}

async function localChats(profileId: string): Promise<Doc<ChatValue>> {
  const doc: Doc<ChatValue> = {}
  for (const c of await db.conversations.where("profileId").equals(profileId).toArray()) {
    doc[c.id] = {
      at: c.changedAt,
      value: {
        title: c.title,
        titleEdited: c.titleEdited,
        hermesSessionId: c.hermesSessionId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        contextTokens: c.contextTokens,
        contextApproximate: c.contextApproximate,
      },
    }
  }
  const tombstones = await db.tombstones.where("id").startsWith("chat:").toArray()
  for (const tombstone of tombstones.filter((t) => t.profileId === profileId)) {
    doc[tombstone.id.slice("chat:".length)] = { at: tombstone.deletedAt, deleted: true }
  }
  return doc
}

async function applyChats(profileId: string, pull: [string, Entry<ChatValue>][]) {
  for (const [id, entry] of pull) {
    const existing = await db.conversations.get(id)
    // Two bots on one server share its chat list; each chat stays with the bot that has it.
    if (existing && existing.profileId !== profileId) continue
    if (entry.deleted) {
      if (existing) await deleteConversation(id, { remote: true })
    } else if (entry.value) {
      await db.transaction("rw", db.conversations, db.tombstones, async () => {
        await db.conversations.put({
          ...(await db.conversations.get(id)),
          ...entry.value!,
          id,
          profileId,
          changedAt: entry.at,
        })
        await db.tombstones.delete(`chat:${id}`)
      })
    }
  }
}

/** Drops tombstones the merged list now carries. */
async function settleChatTombstones(profileId: string, merged: Doc<ChatValue>) {
  const tombstones = await db.tombstones.where("id").startsWith("chat:").toArray()
  for (const tombstone of tombstones.filter((t) => t.profileId === profileId)) {
    const id = tombstone.id.slice("chat:".length)
    if (merged[id]?.at === tombstone.deletedAt) await db.tombstones.delete(tombstone.id)
  }
}

async function syncChats(key: CryptoKey, profileId: string) {
  const merged = await syncDoc<ChatValue>(
    key,
    `chats/${profileId}`,
    () => localChats(profileId),
    (pull) => applyChats(profileId, pull),
  )
  await settleChatTombstones(profileId, merged)
}

/** Syncs a bot's chats with its server's Memento plugin; undefined when the server didn't answer. */
async function syncPluginChats(profile: Profile): Promise<ChatStore | undefined> {
  const local = await localChats(profile.id)
  let merged: Doc<ChatValue>
  try {
    merged = await mergeChatList(profile, local)
  } catch (error) {
    if (!(error instanceof HermesError) || (error.status && error.status !== 404)) return undefined
    // Hermes's 404 for an unknown route skips its CORS middleware, so fetch fails without a
    // status. If the server itself answers, it's the plugin that's missing (or too old).
    try {
      await checkHealth(profile)
    } catch {
      return undefined
    }
    return "fallback"
  }
  await applyChats(profile.id, mergeDocs(merged, local).pull)
  await settleChatTombstones(profile.id, merged)
  return "plugin"
}

async function fingerprint() {
  const [profiles, conversations, tombstones, settings] = await Promise.all([
    db.profiles.toArray(),
    db.conversations.orderBy("id").toArray(),
    db.tombstones.count(),
    getSettings(),
  ])
  const bots = profiles.map((p) => `${p.id}@${p.updatedAt}`).join(",")
  const chats = conversations.reduce((n, c) => Math.max(n, c.changedAt), 0)
  return `${bots}|${conversations.length}@${chats}|${tombstones}|${settings.onboarded}`
}

/** How often a bot without the plugin is asked again, in case it was installed since. */
const PROBE_INTERVAL_MS = 5 * 60_000
const probedAt = new Map<string, number>()

let running: Promise<void> | undefined
let again = false
let syncedFingerprint = ""

async function runSync() {
  const key = state.vault === "unlocked" ? await localKey() : undefined
  try {
    if (key) await syncBots(key)
    const chatStores = { ...state.chatStores }
    // A new device's seed bot may point at a server it's about to be swapped out for.
    const { onboarded } = await getSettings()
    for (const profile of await db.profiles.toArray()) {
      if (!onboarded) {
        if (key) await syncChats(key, profile.id)
        continue
      }
      // Once found, a bot keeps to the plugin until the user says it's gone, so an unreachable
      // server never sends its chats back to the fallback.
      if (profile.pluginChats) {
        chatStores[profile.id] =
          (await syncPluginChats(profile)) === "plugin" ? "plugin" : "unreachable"
        continue
      }
      const known = chatStores[profile.id]
      // Until the plugin has answered, the fallback goes first, so what only it holds moves over.
      if (key) await syncChats(key, profile.id)
      if (
        known === "fallback" &&
        Date.now() - (probedAt.get(profile.id) ?? 0) < PROBE_INTERVAL_MS
      ) {
        continue
      }
      probedAt.set(profile.id, Date.now())
      const store = (await syncPluginChats(profile)) ?? known
      // Not a synced change (no clock bump): each device finds the plugin itself.
      if (store === "plugin") await db.profiles.update(profile.id, { pluginChats: true })
      if (store) chatStores[profile.id] = store
    }
    setState({ chatStores })
    syncedFingerprint = await fingerprint()
    if (!key) return setState({ syncing: false })
    const syncedAt = Date.now()
    await saveSettings({ syncedAt })
    setState({ syncing: false, error: undefined, syncedAt })
  } catch (error) {
    setState({ syncing: false, error: error instanceof Error ? error.message : "Sync failed" })
  }
}

/** Syncs now, or once more after the sync already running. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  setState({ syncing: true })
  running = runSync().finally(() => {
    running = undefined
    if (again) {
      again = false
      void syncNow()
    }
  })
  return running
}

/** Asks every bot's server for the plugin again, without waiting for the next probe. */
export function recheckChatStores() {
  probedAt.clear()
  return syncNow()
}

/** For a bot whose server no longer has the plugin: back to looking for it, and the fallback. */
export async function stopUsingPlugin(profileId: string) {
  await db.profiles.update(profileId, { pluginChats: false })
  const { [profileId]: _forgotten, ...chatStores } = state.chatStores
  setState({ chatStores })
  probedAt.delete(profileId)
  return syncNow()
}

let started = false

/** Signs in from a GitHub redirect if there is one, then keeps this device in sync. */
export async function startSync() {
  if (started) return
  started = true
  setState({ syncedAt: (await getSettings()).syncedAt })
  const onAccount = async (account: Account) => {
    setState({ account })
    if (account.status !== "signed-in") return
    try {
      await refreshVault()
      void syncNow()
    } catch (error) {
      // A key already on this device keeps the app usable while the sync function is unreachable.
      const unlocked = Boolean(await localKey())
      setState({
        vault: unlocked ? "unlocked" : state.vault,
        error: error instanceof Error ? error.message : "Sync failed",
      })
    }
  }
  await onAccount(await loadAccount())
  if (state.account.status !== "unavailable") {
    watchAccount((account) => {
      const before = userId()
      const after = account.status === "signed-in" ? account.user.id : undefined
      // Token refreshes re-announce the same user; only a change of user matters here.
      if (before !== after) void onAccount(account)
    })
  }
  // Chat lists on the plugin need no account.
  void syncNow()

  let timer: number | undefined
  liveQuery(fingerprint).subscribe((value) => {
    if (value === syncedFingerprint) return
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void syncNow(), 1500)
  })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncNow()
  })
  window.addEventListener("online", () => void syncNow())
}
