import { useSyncExternalStore } from "react"
import { liveQuery } from "dexie"

import { ACCOUNT_SYNC_MS, READ_TIMEOUT_MS, CHATS_MERGE_WAIT_MS } from "@/lib/freshness"
import { noteFailure, quietly } from "@/lib/report"
import { createSignal } from "@/lib/store"
import { connectionKey } from "@/lib/connection"
import { onWake } from "@/lib/wake"
import { syncsAccount, type SyncTrigger } from "@/lib/sync-scope"
import { within } from "@/lib/within"
import {
  deleteDoc,
  getDoc,
  loadAccount,
  putDoc,
  signOut as identitySignOut,
  watchAccount,
  type Account,
} from "@/lib/account"
import { hasPluginFeature, mergeChatList } from "@/lib/hermes"
import { adoptDraft, draftKey } from "@/lib/drafts"
import { adoptSessionMode } from "@/lib/workspace"
import {
  APPEARANCE_FIELDS,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  adoptAppearance,
  botTombstones,
  chatTombstones,
  db,
  deleteConversation,
  deleteProfile,
  getSettings,
  promptTombstones,
  saveSettings,
  type Appearance,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { mergeDocs, type Doc, type Entry } from "@/lib/merge"
import { syncRegistry } from "@/lib/registry"
import { markResume } from "@/lib/resume-trace"
import {
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
 * each bot's chat list lives with the Gots plugin on its own Hermes server. Everything sent to
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
  "afk",
  "resolvedAt",
  "discardedAt",
  "draftAt",
  "draftText",
  "mode",
  "modelChoice",
  "muted",
  "main",
] as const
type ChatValue = Pick<Conversation, (typeof CHAT_FIELDS)[number]>

/** Whether the bot's Gots plugin answered the last chat list sync. */
export type ChatStore = "plugin" | "unreachable"

export interface SyncState {
  account: Account
  vault: "unknown" | "missing" | "locked" | "unlocked"
  passkeys: boolean
  /** The chat lists are merging. It ends when the bots that answer have, not when a dead one times out. */
  syncingChats: boolean
  /** The account documents — bots, the appearance switches, the prompt library — are being read or written. */
  syncingAccount: boolean
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
  syncingChats: false,
  syncingAccount: false,
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

/**
 * Writes the vault with `change` applied, reading it fresh for each attempt: another device may
 * have written first (the etag then fails the put), and the vault is left fresh either way so the
 * next caller doesn't write over a stale one. False means every attempt lost the race.
 */
async function writeVault(change: (vault: Vault) => Vault, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!remoteVault) return false
    const { vault, etag } = remoteVault
    if (await putDoc("vault", change(vault), etag)) {
      await refreshVault()
      return true
    }
    await refreshVault()
  }
  return false
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
  const name = user.email ?? user.name ?? "Gots"
  return { id: user.id, name, displayName: user.name ?? name }
}

/** A first run held in memory until its recovery code has been copied. */
export interface PendingSetup {
  recoveryCode: string
  /** Adds this device's passkey to the vault about to be written. Cancelling changes nothing. */
  addPasskey: () => Promise<void>
  /** Writes the vault, its inbox and this device's key. */
  confirm: () => Promise<void>
}

/**
 * First-time setup: a new data key wrapped by a recovery code. Nothing reaches the server until
 * `confirm`, so a tab closed on the code screen leaves no vault wrapped by a code nobody saw — the
 * device simply starts again. The optional passkey joins the same in-memory vault for the same
 * reason: a prompt the user can cancel can never stop setup or strand the account.
 */
export async function setUpSync(): Promise<PendingSetup> {
  const dataKey = await generateDataKey()
  const vault = newVault()
  const recoveryCode = newRecoveryCode()
  vault.wrappers.push(await recoveryWrapper(dataKey, recoveryCode))
  const { inbox, privateKey } = await newInbox(dataKey, inboxAad())
  vault.inbox = inbox
  return {
    recoveryCode,
    addPasskey: async () => {
      vault.wrappers.push(await passkeyWrapper(dataKey, vault, passkeyUser()))
    },
    confirm: async () => {
      if (!(await putDoc("vault", vault))) {
        await refreshVault()
        throw new Error("Sync was already set up from another device. Unlock it instead.")
      }
      await refreshVault()
      await db.vault.put({ id: "inbox", userId: userId()!, key: privateKey, keyId: inbox.keyId })
      await keep(dataKey)
    },
  }
}

/** Whether this device holds the key (or a passkey to unwrap it), so it can mint a new code. */
export function canRotateRecoveryCode() {
  return Boolean(sessionKey) || state.passkeys
}

/**
 * Mints a new recovery code: the new wrapper is written first and the old ones are dropped only
 * from `confirm`, once the user has copied it. A save that fails halfway therefore leaves both
 * codes working rather than leaving the account with neither.
 */
export async function rotateRecoveryCode(currentCode?: string) {
  if (!remoteVault) throw new Error("Sync isn't set up yet.")
  const dataKey =
    sessionKey ??
    (state.passkeys
      ? await unlockWithPasskey(remoteVault.vault)
      : currentCode
        ? await unlockWithRecoveryCode(remoteVault.vault, currentCode)
        : undefined)
  if (!dataKey) throw new Error("Enter your current recovery code.")
  sessionKey = dataKey
  const code = newRecoveryCode()
  const wrapper = await recoveryWrapper(dataKey, code)
  const added = await writeVault((vault) => ({ ...vault, wrappers: [...vault.wrappers, wrapper] }))
  if (!added) throw new Error("Couldn't save the new recovery code. Try again.")
  return {
    code,
    confirm: async () => {
      await writeVault((vault) => ({
        ...vault,
        wrappers: vault.wrappers.filter((w) => w.kind !== "recovery" || w.iv === wrapper.iv),
      }))
    },
  }
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
  // Minted once, outside the write: the prompt is a user's, not a retry's.
  const wrapper = await passkeyWrapper(dataKey, remoteVault.vault, passkeyUser())
  const added = await writeVault((vault) => ({ ...vault, wrappers: [...vault.wrappers, wrapper] }))
  if (!added) throw new Error("Couldn't save the passkey. Try again.")
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
  for (const tombstone of await botTombstones()) {
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
  for (const tombstone of await botTombstones()) {
    if (merged[tombstone.profileId]?.at !== tombstone.deletedAt) continue
    await deleteDoc(`chats/${tombstone.profileId}`).catch(() => undefined)
    await db.tombstones.delete(tombstone.id)
  }
}

/**
 * One entry of the account's prompt library, as the `prompts` document holds it: the name it is
 * found by, the tags it is searched with, and the body a pick copies into a project's Prompt.
 */
interface PromptValue {
  name: string
  tags: string[]
  body: string
}

async function localPrompts(): Promise<Doc<PromptValue>> {
  const doc: Doc<PromptValue> = {}
  for (const entry of await db.prompts.toArray()) {
    const { name, tags, body } = entry
    doc[entry.id] = { at: entry.updatedAt, value: { name, tags, body } }
  }
  for (const tombstone of await promptTombstones()) {
    doc[tombstone.entryId] = { at: tombstone.deletedAt, deleted: true }
  }
  return doc
}

/**
 * The account's prompts, merged record by record like the bots: two devices editing different
 * entries never fight, and a deletion is a tombstone that outlives the row. Two devices editing the
 * same entry keep the later clock, the last-write-wins a bot's own rename already has.
 */
async function syncPrompts(key: CryptoKey) {
  try {
    const merged = await syncDoc<PromptValue>(key, "prompts", localPrompts, async (pull) => {
      for (const [id, entry] of pull) {
        if (entry.deleted) {
          if (await db.prompts.get(id)) await db.prompts.delete(id)
        } else if (entry.value) {
          await db.transaction("rw", db.prompts, db.tombstones, async () => {
            await db.prompts.put({ ...entry.value!, id, updatedAt: entry.at })
            await db.tombstones.delete(`prompt:${id}`)
          })
        }
      }
    })
    // A deletion this device pushed lives on in the document; the row itself needn't be named again.
    for (const tombstone of await promptTombstones()) {
      if (merged[tombstone.entryId]?.at === tombstone.deletedAt)
        await db.tombstones.delete(tombstone.id)
    }
  } catch (error) {
    // A sync function that doesn't know this document yet — a newer app against an older deployment
    // — mustn't take the bots and the chat lists down with it, so it is noted and goes by.
    noteFailure("Syncing the prompt library", error)
  }
}

/**
 * The appearance switches as the `settings` document's one record, each field of
 * `APPEARANCE_FIELDS` named so adding one to the list fails to compile here. `appearanceAt` is 0
 * until the user changes a switch here, so a choice made on another device wins until then; the
 * defaults `DEFAULT_SETTINGS` holds are what a device that never touched them pushes.
 */
async function localAppearance(): Promise<Doc<Appearance>> {
  const { appearanceAt, steerByDefault, breakReminders, navShortcuts } = await getSettings()
  return {
    appearance: {
      at: appearanceAt ?? 0,
      value: {
        steerByDefault: steerByDefault ?? DEFAULT_SETTINGS.steerByDefault,
        breakReminders: breakReminders ?? DEFAULT_SETTINGS.breakReminders,
        navShortcuts: navShortcuts ?? DEFAULT_SETTINGS.navShortcuts,
      },
    },
  }
}

async function syncAppearance(key: CryptoKey) {
  try {
    await syncDoc<Appearance>(key, "settings", localAppearance, async (pull) => {
      for (const [, entry] of pull) {
        if (entry.value) await adoptAppearance(entry.value, entry.at)
      }
    })
  } catch (error) {
    // The switches aren't worth the bots, the registry and every chat list this pass carries, so a
    // settings document this deployment doesn't know yet, or a plain failure, is noted and goes by.
    noteFailure("Syncing the appearance switches", error)
  }
}

// A plugin older than the draft_text feature rejects a record over its 16 KB cap, failing the whole
// merge, so drafts only go to a plugin that advertises the feature, and never in a record over 64 KB.
const DRAFT_RECORD_CAP = 64 * 1024
const encoder = new TextEncoder()

async function localChats(profileId: string, drafts: boolean): Promise<Doc<ChatValue>> {
  const doc: Doc<ChatValue> = {}
  for (const c of await db.conversations.where("profileId").equals(profileId).toArray()) {
    const value = Object.fromEntries(CHAT_FIELDS.map((field) => [field, c[field]])) as ChatValue
    // Only a record that carries a draft is measured.
    if (
      value.draftText !== undefined &&
      (!drafts || encoder.encode(JSON.stringify(value)).length > DRAFT_RECORD_CAP)
    )
      delete value.draftText
    doc[c.id] = { at: c.changedAt, value }
  }
  for (const tombstone of await chatTombstones()) {
    if (tombstone.profileId !== profileId) continue
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
      const value = entry.value
      await db.transaction("rw", db.conversations, db.tombstones, async () => {
        // Field by field, so a record that dropped one (a reopened session) clears it here too.
        const synced = Object.fromEntries(CHAT_FIELDS.map((field) => [field, value[field]]))
        // Except the chat's model: a record naming none has nothing to say about it, because every
        // choice made here writes either a pick or the Default row's marker. Clearing it would lose
        // the pin, and the next merge would carry the loss back to the plugin as well.
        if (value.modelChoice === undefined) delete synced.modelChoice
        await db.conversations.put({
          ...(await db.conversations.get(id)),
          ...synced,
          id,
          profileId,
          changedAt: entry.at,
        } as Conversation)
        await db.tombstones.delete(`chat:${id}`)
      })
      // A pulled draft fills an empty composer here; it never overwrites text typed on this device.
      if (entry.value.draftText) await adoptDraft(draftKey(id), entry.value.draftText)
      // A pick made on another device follows the session here, and out to the plugin.
      if (entry.value.mode && entry.value.mode !== existing?.mode)
        await adoptSessionMode(id, entry.value.mode)
    }
  }
}

/** Drops tombstones the merged list now carries. */
async function settleChatTombstones(profileId: string, merged: Doc<ChatValue>) {
  for (const tombstone of await chatTombstones()) {
    if (tombstone.profileId !== profileId) continue
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
  const local = await localChats(profileId, false)
  await applyChats(profileId, mergeDocs(remote.entries, local).pull)
  return true
}

/**
 * Merges the bot's chat list with its plugin's; the merged list, or undefined when the bot's server
 * didn't answer. Only the host read can say the bot is away — a local read that fails is this
 * device's problem and leaves the pass, rather than being blamed on the server.
 */
async function mergePluginChats(profile: Profile) {
  const drafts = await hasPluginFeature(profile, "draft_text")
  const local = await localChats(profile.id, drafts)
  try {
    const merged = await mergeChatList(profile, local, AbortSignal.timeout(READ_TIMEOUT_MS))
    markResume("chats-merge-end", { requests: 1 })
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
  const appearance = APPEARANCE_FIELDS.map((field) => `${settings[field] ? 1 : 0}`).join("")
  return `${bots}|${count}@${newest?.changedAt ?? 0}|${tombstones}|${settings.onboarded}|${appearance}@${settings.appearanceAt ?? 0}|prompts@${settings.promptsAt ?? 0}`
}

let chatLane: Promise<void> | undefined
let accountLane: Promise<void> | undefined
/** Chat lists asked for again while their lane ran: every bot, or only those named. */
let againChats: "all" | Set<string> | undefined
let againAccount = false
/** When the account documents last completed, on this launch only, so a fresh launch reads them. */
let accountSyncedAt: number | undefined
/** The account documents' failure, for the completion that reports it and puts it in `state.error`. */
let accountError: string | undefined
let syncedFingerprint = ""
/** The merges still out, so a pass that takes over for one more doesn't ask a bot twice. */
const merging = new Map<string, Promise<Awaited<ReturnType<typeof mergePluginChats>>>>()

/** What a request covers: the chat lists, and the account documents too. */
interface SyncAsk {
  chats: boolean
  account: boolean
}

/** The data key, when this device holds one: without it the account's documents can't be read. */
async function currentKey() {
  return state.vault === "unlocked" ? await localKey() : undefined
}

/** Marks chat lists for one more merge once the pass running now has finished. */
function againChatList(only?: Set<string>) {
  if (againChats === "all" || !only) againChats = "all"
  else if (againChats) for (const id of only) againChats.add(id)
  else againChats = new Set(only)
}

/** The bots the next pass covers, clearing the ask: every bot, or only those named. */
function takeAgainChats() {
  const only = againChats === "all" ? undefined : againChats
  againChats = undefined
  return only
}

/** One bot's merge, shared with a pass that asks for it while it's still out. */
function mergeOnce(profile: Profile) {
  const started = merging.get(profile.id)
  if (started) return started
  const work = mergePluginChats(profile).finally(() => merging.delete(profile.id))
  merging.set(profile.id, work)
  return work
}

/**
 * The chat lists: every bot's, merged side by side, and once more if anything asked for them while
 * this pass ran. Its failures stay here — a bot's server being away is `chatStores`' news, not the
 * account's.
 */
function startChatLane(key: CryptoKey | undefined, only?: Set<string>) {
  if (chatLane) {
    againChatList(only)
    return chatLane
  }
  setState({ syncingChats: true })
  const run = async () => {
    for (let ids = only; ;) {
      await syncChatLists(key, ids)
      // What the merge pulled in isn't a change of this device's to push back.
      syncedFingerprint = await fingerprint()
      if (!againChats) break
      ids = takeAgainChats()
    }
  }
  chatLane = run()
    .catch(quietly("Syncing the chat lists"))
    .finally(() => {
      chatLane = undefined
      setState({ syncingChats: false })
      // Asked for in the breath between the loop ending and this: it still gets its pass.
      if (againChats) void startChatLane(key, takeAgainChats())
    })
  return chatLane
}

/**
 * The account documents, on their own lane so a slow or failing Netlify can't stand between a
 * return to the app and the chat lists. A bot the registry adds during the pass had no chat list
 * when the chat lane read its bots, so its own list is merged before this ends.
 */
function startAccountLane(key: CryptoKey | undefined) {
  if (accountLane) {
    againAccount = true
    return accountLane
  }
  setState({ syncingAccount: true })
  const run = async () => {
    for (;;) {
      const added = key ? await syncAccountDocs(key) : []
      if (key) accountSyncedAt = Date.now()
      if (added.length) await startChatLane(key, new Set(added))
      if (!againAccount) break
      againAccount = false
    }
  }
  accountLane = run()
    .catch((error) => {
      accountError = error instanceof Error ? error.message : "Sync failed"
    })
    .finally(() => {
      accountLane = undefined
      setState({ syncingAccount: false })
      if (againAccount) {
        againAccount = false
        void startAccountLane(key)
      }
    })
  return accountLane
}

/**
 * Runs what a request covers. `trigger` is set by a request that is a whole sync — a return to the
 * app, or a change made here — so the trace marks it once, and never for the chat-list-only asks a
 * stream's events make.
 */
async function requestSync(ask: SyncAsk, trigger?: SyncTrigger, only?: Set<string>) {
  if (trigger) markResume("sync-start")
  // A return inside the account documents' freshness reads the chat lists alone.
  const readsAccount =
    ask.account &&
    (!trigger ||
      syncsAccount({
        trigger,
        lastSyncedAt: accountSyncedAt,
        now: Date.now(),
        every: ACCOUNT_SYNC_MS,
      }))
  const key = await currentKey()
  // A lane that is free starts now and one that is running takes this for once more, so the ask
  // never becomes a second pass: it's the lane's own state, not a decision taken outside it.
  if (ask.chats) startChatLane(key, only)
  if (readsAccount) startAccountLane(key)
  await Promise.all([ask.chats ? chatLane : undefined, readsAccount ? accountLane : undefined])
  await finishSync(key, readsAccount)
  if (trigger) markResume("sync-end")
}

/** Reports a sync with nothing left running. A request still working reports its own. */
async function finishSync(key: CryptoKey | undefined, readDocuments: boolean) {
  if (chatLane || accountLane) return
  if (readDocuments) {
    const error = accountError
    accountError = undefined
    if (error) return setState({ error })
  }
  syncedFingerprint = await fingerprint()
  // Last synced is a whole sync's: a chat list merged on its own says nothing about the documents.
  if (!key || !readDocuments) return
  const syncedAt = Date.now()
  await saveSettings({ syncedAt })
  setState({ error: undefined, syncedAt })
}

/** Merges each bot's chat list with its plugin's: every bot's, or only those `only` names. */
async function syncChatLists(key: CryptoKey | undefined, only?: Set<string>) {
  const seed = await pristineSeed()
  const { movedChats = [] } = await getSettings()
  const moved = [...movedChats]
  // Turned off: nothing checks on it. Without a key, Hermes keeps no session for our ids.
  const profiles = (await db.profiles.toArray()).filter(
    (p) => !p.disabled && p.apiKey && p.id !== seed?.id && (!only || only.has(p.id)),
  )
  const held = new Set<string>()
  // A bot's old list on Netlify moves side by side too: one slow list holds up no one else's.
  await Promise.all(
    profiles.map(async (profile) => {
      if (!key || moved.includes(profile.id)) return
      if (await pullFallbackChats(key, profile.id)) held.add(profile.id)
    }),
  )
  // One group per server: bots on one server share its list, so they merge side by side and apply
  // in the order they were added, and a server that never answers holds up only its own bots.
  const groups = new Map<string, Profile[]>()
  for (const profile of profiles) {
    const members = groups.get(connectionKey(profile))
    if (members) members.push(profile)
    else groups.set(connectionKey(profile), [profile])
  }
  // What the rows say, written once the pass stops waiting rather than once per bot, and once more
  // for a bot that lands later: its rows are here, so it is no longer news that it was out.
  const stores = { ...state.chatStores }
  let reported = false
  const report = async (late: boolean) => {
    reported = true
    // Merged over what the state holds, since a later pass may have answered while this one waited.
    setState({ chatStores: { ...state.chatStores, ...stores } })
    // A merge that landed after the pass ended pulled rows in; they aren't ours to push back.
    if (late) syncedFingerprint = await fingerprint()
  }
  const passes = [...groups.values()].map(async (members) => {
    const merged = await Promise.all(members.map(mergeOnce))
    for (const [i, profile] of members.entries()) {
      const answer = merged[i] ? "plugin" : "unreachable"
      if (stores[profile.id] !== answer) stores[profile.id] = answer
      await applyChatList(profile, merged[i], { key, held, moved })
    }
    if (reported) await report(true)
  })
  // A bot still out after this is left to land on its own: the pass reports what answered.
  const settled = Promise.allSettled(passes).then((results) => {
    for (const result of results)
      if (result.status === "rejected") noteFailure("Applying the chat lists", result.reason)
  })
  await within(settled, CHATS_MERGE_WAIT_MS)
  if (!reported) await report(false)
}

/** Applies one bot's answer: its rows and tombstones, and its old Netlify list moved off. */
async function applyChatList(
  profile: Profile,
  result: Awaited<ReturnType<typeof mergePluginChats>>,
  { key, held, moved }: { key: CryptoKey | undefined; held: Set<string>; moved: string[] },
) {
  if (!result) return
  await applyChats(profile.id, mergeDocs(result.merged, result.local).pull)
  await settleChatTombstones(profile.id, result.merged)
  if (!key || moved.includes(profile.id)) return
  if (held.has(profile.id)) await deleteDoc(`chats/${profile.id}`).catch(() => undefined)
  moved.push(profile.id)
  // The whole list each time: a pass moves several bots side by side, and the later write is the
  // longer one, so no id is lost between two of them.
  await saveSettings({ movedChats: [...moved] })
}

/** The account documents: what every device shares, and the registry that names its bots. */
async function syncAccountDocs(key: CryptoKey) {
  await ensureInbox(key)
  // Bots, the appearance switches and the prompt library are separate documents, so they go side
  // by side; the registry read follows, since it wants the inbox key.
  await Promise.all([syncBots(key), syncAppearance(key), syncPrompts(key)])
  markResume("account-docs-end")
  const added = await pullRegistry()
  markResume("registry-end")
  return added
}

/**
 * Reads the registry, answering the bots it added; once a linked bot is in, the untouched seed bot
 * makes way for it.
 */
async function pullRegistry(): Promise<string[]> {
  // Looked for first: once linked bots are in, the seed is no longer the only bot.
  const seed = await pristineSeed()
  const known = new Set((await db.profiles.toArray()).map((profile) => profile.id))
  try {
    await syncRegistry()
    setState({ registryError: undefined })
  } catch (error) {
    setState({ registryError: error instanceof Error ? error.message : "Couldn't refresh bots" })
    return []
  }
  if (seed && (await db.profiles.filter((p) => Boolean(p.hostId)).count())) {
    await deleteProfile(seed.id, { remote: true })
  }
  return (await db.profiles.toArray()).map((profile) => profile.id).filter((id) => !known.has(id))
}

/** Reads the registry now, for screens that wait on a bot to link. */
export async function refreshBots() {
  if (state.vault !== "unlocked") return
  await pullRegistry()
}

/**
 * Merges the chat lists of these bots only, for a server whose plugin said its list changed. The
 * pass already sent its merge before that change, so one that is running takes this for once more.
 */
export function syncChatsOf(botIds: string[]): Promise<void> {
  return requestSync({ chats: true, account: false }, undefined, new Set(botIds))
}

/** A whole sync: the account documents and the chat lists, for a change made here, a sign-in, or
 * the Settings button. Never waits on how recently the documents were read. */
export function syncNow(): Promise<void> {
  return requestSync({ chats: true, account: true }, "full")
}

/**
 * A return to the app: the chat lists at once, and the account documents beside them only once
 * they're stale, so Netlify can't stand between the return and the chats. `onWake` asks for this
 * after a while away or when the network comes back; a flick away and back is left to the stream,
 * whose connection never closed.
 */
export function wakeSync(): Promise<void> {
  return requestSync({ chats: true, account: true }, "wake")
}

let started = false

/** Signs in from a GitHub redirect if there is one, then keeps this device in sync. */
export async function startSync() {
  if (started) return
  started = true
  setState({ syncedAt: (await getSettings()).syncedAt })
  const onAccount = async (account: Account) => {
    setState({ account })
    // Another account's documents are read at once, throttle or no throttle.
    accountSyncedAt = undefined
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
  onWake(() => void wakeSync())
}
