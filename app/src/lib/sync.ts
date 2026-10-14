import { useSyncExternalStore } from "react"
import { liveQuery } from "dexie"

import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { noteFailure, quietly } from "@/lib/report"
import { createSignal } from "@/lib/store"
import {
  deleteDoc,
  getDoc,
  loadAccount,
  putDoc,
  signOut as identitySignOut,
  watchAccount,
  type Account,
} from "@/lib/account"
import { mergeChatList } from "@/lib/hermes"
import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  db,
  deleteConversation,
  deleteProfile,
  getSettings,
  saveSettings,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { mergeDocs, type Doc, type Entry } from "@/lib/merge"
import { syncRegistry } from "@/lib/registry"
import {
  PrfUnsupportedError,
  generateDataKey,
  hasPasskeys,
  lockDown,
  newRecoveryCode,
  newInbox,
  newVault,
  openInbox,
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
 * Syncs bots, the appearance switches and the chat list (titles, Hermes session ids and context
 * use, not messages). Bots come from the registry and the sealed `bots` document; the Appearance
 * section's switches from the `settings` document, which every device merges on `appearanceAt`;
 * each bot's chat list lives with the Memento plugin on its own Hermes server. Everything sent to
 * Netlify is sealed with the account's data key, and each document's associated data names its
 * owner and slot, so the server can't swap one document for another.
 */

/**
 * What each device keeps for itself: the registry's copies, and what it looks up from models.dev,
 * which a newer lookup here mustn't push over a rename made on another device.
 */
const LOCAL_BOT_FIELDS = [
  "disabled",
  "seenAt",
  "pluginVersion",
  "contextWindow",
  "contextModel",
  "imageInput",
] as const
type BotValue = Omit<Profile, "id" | "updatedAt" | (typeof LOCAL_BOT_FIELDS)[number]>
const CHAT_FIELDS = [
  "title",
  "titleEdited",
  "hermesSessionId",
  "createdAt",
  "updatedAt",
  "projectId",
  "resolvedAt",
  "discardedAt",
  "draftAt",
  "modelChoice",
  "muted",
] as const
type ChatValue = Pick<Conversation, (typeof CHAT_FIELDS)[number]>

/** Whether the bot's Memento plugin answered the last chat list sync. */
export type ChatStore = "plugin" | "unreachable"

export interface SyncState {
  account: Account
  vault: "unknown" | "missing" | "locked" | "unlocked"
  passkeys: boolean
  syncing: boolean
  error?: string
  syncedAt?: number
  /** By profile id; missing until the bot's server has answered. */
  chatStores: Record<string, ChatStore>
  /** Why the last registry read failed, if it did. */
  registryError?: string
}

let state: SyncState = {
  account: { status: "loading" },
  vault: "unknown",
  passkeys: false,
  syncing: false,
  chatStores: {},
}
const stateSignal = createSignal()

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  stateSignal.notify()
}

export function useSyncState() {
  return useSyncExternalStore(stateSignal.subscribe, () => state)
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

function inboxAad() {
  return `memento:${userId()}:inbox`
}

/** The account's inbox public key, which link codes carry the fingerprint of. */
export function inboxPublic() {
  return remoteVault?.vault.inbox?.publicKey
}

/** This device's copy of the inbox's private key, for opening bot records plugins publish. */
export async function inboxKey() {
  const stored = await db.vault.get("inbox")
  const current = remoteVault?.vault.inbox?.keyId
  if (!stored || stored.userId !== userId()) return undefined
  return !current || stored.keyId === current ? stored : undefined
}

/** Gives a vault from before the inbox one, and keeps this device's copy of its private key. */
async function ensureInbox(dataKey: CryptoKey) {
  const id = userId()
  if (!id) return
  for (let attempt = 0; attempt < 3 && remoteVault; attempt++) {
    const { vault, etag } = remoteVault
    if (vault.inbox) {
      const stored = await inboxKey()
      if (stored?.keyId === vault.inbox.keyId) return
      const key = await openInbox(dataKey, vault.inbox, inboxAad())
      await db.vault.put({ id: "inbox", userId: id, key, keyId: vault.inbox.keyId })
      return
    }
    const { inbox, privateKey } = await newInbox(dataKey, inboxAad())
    if (await putDoc("vault", { ...vault, inbox }, etag)) {
      await db.vault.put({ id: "inbox", userId: id, key: privateKey, keyId: inbox.keyId })
      await refreshVault()
      return
    }
    // Another device wrote first, maybe with its own inbox; take whichever is there now.
    await refreshVault()
  }
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
  const { inbox, privateKey } = await newInbox(dataKey, inboxAad())
  vault.inbox = inbox
  if (!(await putDoc("vault", vault))) {
    await refreshVault()
    throw new Error("Sync was already set up from another device. Unlock it instead.")
  }
  await refreshVault()
  await db.vault.put({ id: "inbox", userId: userId()!, key: privateKey, keyId: inbox.keyId })
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

function botValue({ id: _id, updatedAt: _updatedAt, ...profile }: Profile): BotValue {
  const value: Partial<Profile> = { ...profile }
  for (const field of LOCAL_BOT_FIELDS) delete value[field]
  return value as BotValue
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
    async () => {
      const doc = await localBots()
      // The untouched seed is only a placeholder until a bot links; other devices have their own.
      if (seed) delete doc[seed.id]
      return doc
    },
    async (pull, remote) => {
      for (const [id, entry] of pull) {
        if (entry.deleted) {
          if (await db.profiles.get(id)) await deleteProfile(id, { remote: true })
        } else if (entry.value) {
          await db.transaction("rw", db.profiles, db.tombstones, async () => {
            const current = await db.profiles.get(id)
            const local = Object.fromEntries(LOCAL_BOT_FIELDS.map((f) => [f, current?.[f]]))
            await db.profiles.put({ ...entry.value!, ...local, id, updatedAt: entry.at } as Profile)
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

/** What sync carries for the Appearance section's switches: everything there but the colour mode. */
type AppearanceValue = {
  simplifiedChats: boolean
  steerByDefault: boolean
  breakReminders: boolean
}

/**
 * The appearance switches as the `settings` document's one record. `appearanceAt` is 0 until the
 * user changes one here, so a choice made on another device wins until then; the defaults
 * `getSettings` fills in are what a device that never touched them pushes.
 */
async function localAppearance(): Promise<Doc<AppearanceValue>> {
  const { appearanceAt, simplifiedChats, steerByDefault, breakReminders } = await getSettings()
  return {
    appearance: {
      at: appearanceAt ?? 0,
      value: {
        simplifiedChats,
        steerByDefault: steerByDefault ?? false,
        breakReminders: breakReminders ?? DEFAULT_SETTINGS.breakReminders ?? true,
      },
    },
  }
}

async function syncAppearance(key: CryptoKey) {
  await syncDoc<AppearanceValue>(key, "settings", localAppearance, async (pull) => {
    for (const [, entry] of pull) {
      if (entry.value) await saveSettings({ ...entry.value, appearanceAt: entry.at })
    }
  })
}

async function localChats(profileId: string): Promise<Doc<ChatValue>> {
  const doc: Doc<ChatValue> = {}
  for (const c of await db.conversations.where("profileId").equals(profileId).toArray()) {
    doc[c.id] = {
      at: c.changedAt,
      value: Object.fromEntries(CHAT_FIELDS.map((field) => [field, c[field]])) as ChatValue,
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
        // Field by field, so a record that dropped one (a reopened session) clears it here too.
        const synced = Object.fromEntries(CHAT_FIELDS.map((field) => [field, entry.value![field]]))
        await db.conversations.put({
          ...(await db.conversations.get(id)),
          ...synced,
          id,
          profileId,
          changedAt: entry.at,
        } as Conversation)
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

/**
 * Pulls what the bot's old Netlify chat list still holds onto this device, so the plugin sync after
 * it carries it over. True when there was a list to move.
 */
async function pullFallbackChats(key: CryptoKey, profileId: string) {
  const remote = await readDoc<ChatValue>(key, `chats/${profileId}`)
  if (!remote.etag) return false
  const local = await localChats(profileId)
  await applyChats(profileId, mergeDocs(remote.entries, local).pull)
  return true
}

/** Syncs a bot's chats with its server's Memento plugin; false when it didn't answer. */
/** Merges the bot's chat list with its plugin's; the merged list, or undefined when it didn't answer. */
async function mergePluginChats(profile: Profile) {
  const local = await localChats(profile.id)
  try {
    const merged = await mergeChatList(profile, local, AbortSignal.timeout(READ_TIMEOUT_MS))
    return { local, merged }
  } catch (error) {
    noteFailure(`Syncing ${profile.name}'s chats`, error)
    return undefined
  }
}

async function fingerprint() {
  const [profiles, count, newest, tombstones, settings] = await Promise.all([
    db.profiles.toArray(),
    db.conversations.count(),
    db.conversations.orderBy("changedAt").last(),
    db.tombstones.count(),
    getSettings(),
  ])
  const bots = profiles.map((p) => `${p.id}@${p.updatedAt}`).join(",")
  return `${bots}|${count}@${newest?.changedAt ?? 0}|${tombstones}|${settings.onboarded}|${settings.appearanceAt ?? 0}`
}

let running: Promise<void> | undefined
let again = false
let syncedFingerprint = ""

async function runSync() {
  const key = state.vault === "unlocked" ? await localKey() : undefined
  try {
    if (key) await ensureInbox(key)
    if (key) await syncBots(key)
    if (key) await syncAppearance(key)
    if (key) await pullRegistry()
    await syncChatLists(key)
    syncedFingerprint = await fingerprint()
    if (!key) return setState({ syncing: false })
    const syncedAt = Date.now()
    await saveSettings({ syncedAt })
    setState({ syncing: false, error: undefined, syncedAt })
  } catch (error) {
    setState({ syncing: false, error: error instanceof Error ? error.message : "Sync failed" })
  }
}

/** Merges each bot's chat list with its plugin's: every bot's, or only those `only` names. */
async function syncChatLists(key: CryptoKey | undefined, only?: Set<string>) {
  const chatStores = { ...state.chatStores }
  const seed = await pristineSeed()
  const { movedChats = [] } = await getSettings()
  // Turned off: nothing checks on it. Without a key, Hermes keeps no session for our ids.
  const profiles = (await db.profiles.toArray()).filter(
    (p) => !p.disabled && p.apiKey && p.id !== seed?.id && (!only || only.has(p.id)),
  )
  const held = new Set<string>()
  for (const profile of profiles) {
    if (key && !movedChats.includes(profile.id) && (await pullFallbackChats(key, profile.id)))
      held.add(profile.id)
  }
  // Every host at once, so one that hangs holds up only its own bots.
  const results = await Promise.all(profiles.map(mergePluginChats))
  // Applied in order: two bots on one server share its list, and a chat stays with the first.
  for (const [i, profile] of profiles.entries()) {
    const result = results[i]
    chatStores[profile.id] = result ? "plugin" : "unreachable"
    if (!result) continue
    await applyChats(profile.id, mergeDocs(result.merged, result.local).pull)
    await settleChatTombstones(profile.id, result.merged)
    if (key && !movedChats.includes(profile.id)) {
      if (held.has(profile.id)) await deleteDoc(`chats/${profile.id}`).catch(() => undefined)
      await saveSettings({ movedChats: [...movedChats, profile.id] })
      movedChats.push(profile.id)
    }
  }
  setState({ chatStores })
}

/** Reads the registry; once a linked bot is in, the untouched seed bot makes way for it. */
async function pullRegistry() {
  // Looked for first: once linked bots are in, the seed is no longer the only bot.
  const seed = await pristineSeed()
  try {
    await syncRegistry()
    setState({ registryError: undefined })
  } catch (error) {
    setState({ registryError: error instanceof Error ? error.message : "Couldn't refresh bots" })
    return
  }
  if (seed && (await db.profiles.filter((p) => Boolean(p.hostId)).count())) {
    await deleteProfile(seed.id, { remote: true })
  }
}

/** Reads the registry now, for screens that wait on a bot to link. */
export async function refreshBots() {
  if (state.vault !== "unlocked") return
  await pullRegistry()
}

/** Syncs now, or once more after the sync already running. */
/**
 * Merges the chat lists of these bots only, for a server whose plugin said its list changed. A
 * whole sync already running covers them, so it runs once more instead.
 */
export function syncChatsOf(botIds: string[]): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = syncChatLists(undefined, new Set(botIds))
    // What it pulled in isn't a change of this device's to push back.
    .then(async () => void (syncedFingerprint = await fingerprint()))
    .catch(quietly("Syncing chat lists"))
    .finally(() => {
      running = undefined
      if (again) {
        again = false
        void syncNow()
      }
    })
  return running
}

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
