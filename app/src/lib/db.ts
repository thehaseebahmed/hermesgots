import Dexie, { type EntityTable, type Transaction } from "dexie"

import { BOTS, LEGACY_BOT_IDS } from "@/components/bots"
import { randomId } from "@/lib/utils"

export type ThemePreference = "system" | "light" | "dark"

export interface Settings {
  id: "settings"
  showStats: boolean
  activeProfileId?: string
  /** When sync last finished without an error. */
  syncedAt?: number
  /** Finished the first-run setup. */
  onboarded?: boolean
}

/** A Hermes profile Memento can talk to. Hermes can't list its profiles, so the user adds them. */
export interface Profile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** Which of the bot characters represents this profile. */
  botId: string
  /** The model's context window in tokens, from models.dev or set by hand (Hermes doesn't report it). */
  contextWindow?: number
  /** `provider/model` Hermes reported when the window was set; a different one resets it. */
  contextModel?: string
  contextSource?: "models.dev" | "manual"
  createdAt: number
  /** Last change to the config, the clock sync merges on. */
  updatedAt: number
}

export interface Conversation {
  id: string
  profileId: string
  title: string
  /** Renamed by the user, so Hermes's title never replaces it. */
  titleEdited?: boolean
  /** Client-minted id sent as `X-Hermes-Session-Id` so Hermes keeps one session per chat. */
  hermesSessionId: string
  createdAt: number
  updatedAt: number
  /** Last change to anything sync carries (title included), the clock it merges on. */
  changedAt: number
  /**
   * Set while Hermes holds older transcript rows than this device loaded: the oldest loaded row's
   * id, and roughly how many newer rows to skip to reach it.
   */
  olderThan?: { id: number; offset: number }
  /** Prompt tokens of the latest turn, from whichever device ran it (Hermes doesn't report it). */
  contextTokens?: number
  /** That turn ran tools, so Hermes's sum counts the prompt more than once. */
  contextApproximate?: boolean
  /** Newest Hermes transcript row this device has caught up to. Local only; never synced. */
  hermesTip?: number
}

export interface ToolEvent {
  toolCallId: string
  tool: string
  emoji?: string
  label: string
  status: "running" | "completed"
  startedAt: number
  endedAt?: number
  /** Length of the reply text when the tool started, so it renders where it happened. */
  contentOffset?: number
  /** What the call returned (a preview while streaming). */
  result?: string
}

export type ApprovalChoice = "once" | "session" | "always" | "deny"

export interface ApprovalRequest {
  runId: string
  command?: string
  description?: string
  choices: ApprovalChoice[]
  /** Reply length and time when Hermes asked, so the thread can place the card where it happened. */
  contentOffset?: number
  requestedAt?: number
  /** Set once the user answers (or the turn ends without an answer). */
  resolved?: ApprovalChoice | "expired"
}

export interface MessageStats {
  tokens: number
  estimated: boolean
  /** Left out when tools ran: the turn's time then includes tool execution. */
  tokensPerSecond?: number
  durationMs: number
  /** Hermes's prompt tokens for the turn, summed over every model call in it. */
  promptTokens?: number
  toolsUsed?: boolean
}

/** `queued` is a user message waiting for the current reply to finish. */
export type MessageStatus = "queued" | "streaming" | "done" | "error" | "stopped"

export interface Message {
  id: string
  conversationId: string
  role: "user" | "assistant"
  content: string
  reasoning?: string
  tools?: ToolEvent[]
  approval?: ApprovalRequest
  status: MessageStatus
  /** Latest `hermes.status` text while streaming, or the error text. */
  statusText?: string
  stats?: MessageStats
  createdAt: number
  /** The Hermes transcript row a user message was matched to, once the device has seen it. */
  hermesRowId?: number
  /** The run behind a reply and its last event seen, so a dropped stream can pick up again. */
  runId?: string
  runSeq?: number
}

/** A local deletion sync hasn't pushed yet: `bot:<profileId>` or `chat:<conversationId>`. */
export interface Tombstone {
  id: string
  deletedAt: number
  profileId: string
}

/** This device's copy of the sync key, imported non-extractable so script can use but not read it. */
export interface VaultKey {
  id: "key"
  userId: string
  key: CryptoKey
}

export const DEFAULT_SETTINGS: Settings = {
  id: "settings",
  showStats: true,
}

export const DEFAULT_PROFILE = {
  name: "Hermes",
  baseUrl: "http://localhost:8642/v1",
  apiKey: "",
  model: "hermes-agent",
}

export const db = new Dexie("memento") as Dexie & {
  settings: EntityTable<Settings, "id">
  profiles: EntityTable<Profile, "id">
  conversations: EntityTable<Conversation, "id">
  messages: EntityTable<Message, "id">
  tombstones: EntityTable<Tombstone, "id">
  vault: EntityTable<VaultKey, "id">
}

db.version(1).stores({
  settings: "id",
  conversations: "id, updatedAt",
  messages: "id, conversationId, [conversationId+createdAt]",
})

/** Random bot image, unique among `taken` until all of them are in use. */
export function pickBotId(taken: string[]) {
  const free = BOTS.filter((bot) => !taken.includes(bot.id))
  const pool = free.length ? free : BOTS
  return pool[Math.floor(Math.random() * pool.length)].id
}

function newProfile(
  fields: Partial<Omit<Profile, "id" | "createdAt" | "updatedAt">>,
  taken: string[],
): Profile {
  const now = Date.now()
  return {
    ...DEFAULT_PROFILE,
    botId: pickBotId(taken),
    ...fields,
    id: randomId(),
    createdAt: now,
    updatedAt: now,
  }
}

async function seedProfile(tx: Transaction) {
  const settings = await tx.table("settings").get("settings")
  const profile = newProfile(
    {
      baseUrl: settings?.baseUrl ?? DEFAULT_PROFILE.baseUrl,
      apiKey: settings?.apiKey ?? DEFAULT_PROFILE.apiKey,
      model: settings?.model ?? DEFAULT_PROFILE.model,
    },
    [],
  )
  await tx.table("profiles").add(profile)
  return profile
}

// v2: the single connection in settings becomes the first profile and owns every existing chat.
db.version(2)
  .stores({
    profiles: "id, createdAt",
    conversations: "id, updatedAt, [profileId+updatedAt]",
  })
  .upgrade(async (tx) => {
    const profile = await seedProfile(tx)
    await tx.table("conversations").toCollection().modify({ profileId: profile.id })
    await tx
      .table("settings")
      .toCollection()
      .modify((settings: Record<string, unknown>) => {
        delete settings.baseUrl
        delete settings.apiKey
        delete settings.model
        settings.activeProfileId = profile.id
      })
  })

// v3: the bot characters were redrawn with new ids; map each old one onto a distinct new one.
db.version(3).upgrade((tx) =>
  tx
    .table("profiles")
    .toCollection()
    .modify((profile: Profile) => {
      profile.botId = LEGACY_BOT_IDS[profile.botId] ?? profile.botId
    }),
)

// v4: cron run history, grouped by profile and job.
db.version(4).stores({
  cronRuns: "id, profileId, [profileId+jobId+startedAt]",
})

// v5: change clocks and deletion tombstones for sync, and this device's sync key.
db.version(5)
  .stores({ tombstones: "id", vault: "id" })
  .upgrade(async (tx) => {
    await tx
      .table("profiles")
      .toCollection()
      .modify((profile: Profile) => {
        profile.updatedAt ??= profile.createdAt
      })
    await tx
      .table("conversations")
      .toCollection()
      .modify((conversation: Conversation) => {
        conversation.changedAt ??= conversation.updatedAt
      })
  })

// v6: run history comes from the Memento plugin on the Hermes server, not from each device.
db.version(6).stores({ cronRuns: null })

db.on("populate", (tx) => seedProfile(tx))

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }
}

export async function saveSettings(patch: Partial<Omit<Settings, "id">>) {
  const current = await getSettings()
  await db.settings.put({ ...current, ...patch, id: "settings" })
}

export async function listProfiles() {
  return db.profiles.orderBy("createdAt").toArray()
}

/** The selected profile, falling back to the oldest one. */
export async function getActiveProfile(): Promise<Profile | undefined> {
  const { activeProfileId } = await getSettings()
  const active = activeProfileId ? await db.profiles.get(activeProfileId) : undefined
  return active ?? (await db.profiles.orderBy("createdAt").first())
}

export async function setActiveProfile(id: string) {
  await saveSettings({ activeProfileId: id })
}

export async function addProfile(
  fields: Partial<Omit<Profile, "id" | "createdAt" | "updatedAt">> = {},
) {
  const taken = (await db.profiles.toArray()).map((profile) => profile.botId)
  const profile = newProfile(fields, taken)
  await db.profiles.add(profile)
  return profile
}

export async function updateProfile(id: string, patch: Partial<Omit<Profile, "id">>) {
  await db.profiles.update(id, { ...patch, updatedAt: Date.now() })
}

/**
 * Deletes a profile and its chats. The last profile can't be deleted. `remote` is a deletion sync
 * pulled from another device, which needs no tombstone of its own.
 */
export async function deleteProfile(id: string, { remote = false } = {}) {
  const tables = [db.profiles, db.conversations, db.messages, db.tombstones]
  return db.transaction("rw", tables, async () => {
    if ((await db.profiles.count()) <= 1) return false
    const ids = await conversationsOf(id).primaryKeys()
    await db.messages.where("conversationId").anyOf(ids).delete()
    await db.conversations.bulkDelete(ids)
    await db.profiles.delete(id)
    if (!remote) await db.tombstones.put({ id: `bot:${id}`, deletedAt: Date.now(), profileId: id })
    return true
  })
}

/** A profile's chats, oldest activity first. */
export function conversationsOf(profileId: string) {
  return db.conversations
    .where("[profileId+updatedAt]")
    .between([profileId, Dexie.minKey], [profileId, Dexie.maxKey])
}

export async function createConversation(profileId: string): Promise<Conversation> {
  const now = Date.now()
  const conversation: Conversation = {
    id: randomId(),
    profileId,
    title: "New chat",
    hermesSessionId: `memento-${randomId()}`,
    createdAt: now,
    updatedAt: now,
    changedAt: now,
  }
  await db.conversations.add(conversation)
  return conversation
}

/** Every change to a chat's synced fields goes through here so sync sees it. */
export async function updateConversation(
  id: string,
  patch: Partial<Omit<Conversation, "id" | "changedAt">>,
) {
  await db.conversations.update(id, { ...patch, changedAt: Date.now() })
}

export async function deleteConversation(id: string, { remote = false } = {}) {
  await db.transaction("rw", db.conversations, db.messages, db.tombstones, async () => {
    const conversation = await db.conversations.get(id)
    await db.messages.where("conversationId").equals(id).delete()
    await db.conversations.delete(id)
    if (conversation && !remote) {
      await db.tombstones.put({
        id: `chat:${id}`,
        deletedAt: Date.now(),
        profileId: conversation.profileId,
      })
    }
  })
}

export async function getMessages(conversationId: string) {
  return db.messages
    .where("[conversationId+createdAt]")
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
    .toArray()
}

export async function clearAllData() {
  const tables = [db.conversations, db.messages, db.settings, db.profiles, db.tombstones, db.vault]
  await db.transaction("rw", tables, async () => {
    await Promise.all(tables.map((table) => table.clear()))
    await db.profiles.add(newProfile({}, []))
  })
}
