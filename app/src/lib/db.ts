import Dexie, { type EntityTable, type Transaction } from "dexie"

import { BOTS, LEGACY_BOT_IDS } from "@/components/bots"
import { randomId } from "@/lib/utils"

export type ThemePreference = "system" | "light" | "dark"

export interface Settings {
  id: "settings"
  /** Plain chats leave out context use, reply stats and tool calls; project sessions show them. */
  simplifiedChats: boolean
  /** Shows the Developer section in Settings (tapping the version five times). */
  developer?: boolean
  /** Offers Theseus among a project session's modes; a Developer setting, off by default. Local. */
  theseus?: boolean
  /** The bot-first layout: bots in the sidebar, each chat a thread in its bot. Developer, local. */
  botThreads?: boolean
  activeProfileId?: string
  /** When sync last finished without an error. */
  syncedAt?: number
  /** Finished the first-run setup. */
  onboarded?: boolean
  /** Soft-wrap in tool output; unset until the user flips it (wrapped by default). */
  wrapToolOutput?: boolean
  /** Bots whose old Netlify chat list was moved onto their Memento plugin and deleted. */
  movedChats?: string[]
  /** Saw the notice that bots added by hand need linking. */
  linkNoticeSeen?: boolean
  /** This device's Web Push identity, local only: its id, its VAPID key pair and whether it's on. */
  push?: { device: string; vapidKey: string; vapidPublic: string; on: boolean }
  /** The Android app's push identity, local only: Firebase gives the token, this is its device id. */
  fcm?: { device: string; on: boolean }
}

/** A Hermes profile Memento can talk to. Its Memento plugin registers it (see `registry.ts`). */
export interface Profile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** Which of the bot characters represents this profile. */
  botId: string
  /** The model's context window in tokens, from models.dev (Hermes's API doesn't report it). */
  contextWindow?: number
  /** `provider/model` Hermes reported when the window was set; a different one resets it. */
  contextModel?: string
  /** `manual` is a window set by hand on an older version; it is ignored and looked up again. */
  contextSource?: "models.dev" | "manual"
  /** Whether the model takes images, per models.dev; unset when it doesn't list the model. */
  imageInput?: boolean
  /** The model new turns run on when a chat hasn't picked its own; unset runs the host's. */
  modelChoice?: ModelChoice
  /** The last few models picked on this bot, newest first, for switching back quickly. */
  recentModels?: ModelChoice[]
  /** The linked host that registered it; unset for a bot added by hand before linking. */
  hostId?: string
  /** Turned off in the app: hidden, and nothing checks on it. Local copy of the registry's flag. */
  disabled?: boolean
  /** When its host last checked in with the registry. Local only. */
  seenAt?: number
  createdAt: number
  /** Last change to the config, the clock sync merges on. */
  updatedAt: number
}

/** One of the models a Hermes host is configured for. */
export interface ModelChoice {
  provider: string
  model: string
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
  /**
   * The session's latest model call, as the Memento plugin recorded it, and the window Hermes
   * compresses against. Local only; every device reads it from the plugin.
   */
  liveContext?: { tokens: number; window?: number }
  /** Newest Hermes transcript row this device has caught up to. Local only; never synced. */
  hermesTip?: number
  /**
   * The agent's own todo list (its `todo_list` tool) and when this device last set it. Local only;
   * every device reads it from the Memento plugin.
   */
  todos?: { revision: number; items: Todo[]; at: number }
  /** A model the user picked for this chat from its host's configured ones; unset runs the bot's. */
  modelChoice?: ModelChoice
  /** The Hermes Project this chat is a session of (works in its own worktree). */
  projectId?: string
  /** Unsent composer text a session was left with, kept on this device only. */
  draft?: string
  /** When the user saved the session as a draft. Synced, so the plugin's cleanup spares it. */
  draftAt?: number
  /** Marked done by the user, or by the plugin once its pull request merged; the composer gives way until it's reopened. */
  resolvedAt?: number
  /** Moved to the project's Discarded pile: its pull request closed and its branch deleted. */
  discardedAt?: number
  /** Permission mode, as the plugin last reported it. Local only; the plugin holds it. */
  mode?: SessionMode
  /**
   * The session's worktrees (one per repo of the project, all on `branch`), from the plugin, and
   * the line that tells the agent where they are. Local only; no path reaches the UI.
   */
  worktree?: { branch: string; repos: { name: string; branch: string }[]; instructions: string }
  /** A plan-mode turn finished and the plan awaits the user. Local only; the plugin holds it. */
  planPending?: boolean
  /** The newest plan the plugin saved, `plans/<file>.md` under the project's folder. Local only. */
  planFile?: string
  /**
   * Why the session can't take another turn (a repo it works in was removed from the project, or
   * the project is archived), from the plugin. Local only.
   */
  blocked?: string
  /** The branch's pull request in each repo, and when they were last read. Local only. */
  prs?: PullRequestRef[]
}

/** How much a project session may do without asking. */
export type SessionMode = "accept_edits" | "auto" | "plan" | "theseus"

export type PrState = "open" | "draft" | "merged" | "closed"

export type PrChecks = "success" | "failure" | "pending"

export interface PullRequestRef {
  /** `user/repo`. */
  repo: string
  number: number
  title: string
  state: PrState
  /** The head commit's check runs and statuses; null when it has none. */
  checks: PrChecks | null
  url: string | null
  at: number
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface Todo {
  id: string
  content: string
  status: TodoStatus
  /** Another item's id, making this one its subtask. */
  parent?: string
}

export interface ToolEvent {
  toolCallId: string
  tool: string
  emoji?: string
  label: string
  status: "running" | "completed" | "failed"
  startedAt: number
  endedAt?: number
  /** Length of the reply text when the tool started, so it renders where it happened. */
  contentOffset?: number
  /** What the call returned (a preview while streaming). */
  result?: string
  /** Why it failed, read from the whole result before it was clipped. */
  error?: string
  /** Lines a file edit added and removed, counted from the transcript (the stream's preview is cut short). */
  added?: number
  removed?: number
  /** The call made a new file. */
  created?: boolean
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

export interface ClarifyQuestion {
  id: string
  question: string
  /** Pickable answers, the first one recommended; none for an open-ended question. */
  choices?: string[]
  multiSelect?: boolean
}

/** A choice or typed text per question id, a list for multi-select, null for a skipped one. */
export type ClarifyAnswers = Record<string, string | string[] | null>

/** The agent's questions (Hermes's `clarify` tool, served by the Memento plugin). */
export interface ClarifyRequest {
  runId: string
  clarifyId: string
  questions: ClarifyQuestion[]
  /** Set once the user answers (or the turn ends without an answer). */
  resolved?:
    | { answers: ClarifyAnswers; outcome: "submitted" | "cancelled" | "timed_out" | "undelivered" }
    | "expired"
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

/** A photo or file the user added to a message. */
export interface Attachment {
  id: string
  name: string
  /** MIME type. */
  type: string
  size: number
  /** Goes to the model inline as well. */
  image: boolean
  /** The file (an image downscaled), on this device only: Hermes's transcript doesn't keep it. */
  blob?: Blob
  /** Where the Memento plugin saved it on the Hermes host. */
  path?: string
}

/** `queued` is a user message waiting for the current reply to finish. */
export type MessageStatus = "queued" | "streaming" | "done" | "error" | "stopped"

export interface Message {
  id: string
  conversationId: string
  role: "user" | "assistant"
  content: string
  attachments?: Attachment[]
  reasoning?: string
  tools?: ToolEvent[]
  approval?: ApprovalRequest
  clarify?: ClarifyRequest
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

/**
 * This device's copy of the sync key, and of the inbox's private key, each imported non-extractable
 * so script can use but not read it.
 */
export interface VaultKey {
  id: "key" | "inbox"
  userId: string
  key: CryptoKey
  /** The inbox's key id, to tell a rotated inbox apart. */
  keyId?: string
}

export const DEFAULT_SETTINGS: Settings = {
  id: "settings",
  simplifiedChats: true,
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

// v7: project sessions, listed per project.
db.version(7).stores({ conversations: "id, updatedAt, [profileId+updatedAt], projectId" })

// v8: every bot keeps its chats on its Memento plugin, so the per-bot flag for it goes.
db.version(8).upgrade((tx) =>
  tx
    .table("profiles")
    .toCollection()
    .modify((profile: Record<string, unknown>) => {
      delete profile.pluginChats
    }),
)

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

/** The bots the app shows and checks on: every one not turned off. */
export async function listEnabledProfiles() {
  return (await listProfiles()).filter((profile) => !profile.disabled)
}

/** The selected profile, falling back to the oldest one that's turned on. */
export async function getActiveProfile(): Promise<Profile | undefined> {
  const { activeProfileId } = await getSettings()
  const active = activeProfileId ? await db.profiles.get(activeProfileId) : undefined
  if (active && !active.disabled) return active
  const profiles = await listProfiles()
  return profiles.find((profile) => !profile.disabled) ?? active ?? profiles[0]
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

const RECENT_MODELS = 3

/** Puts a model picked on this bot at the top of its recent ones. */
export async function rememberModel(profileId: string, choice: ModelChoice) {
  const profile = await db.profiles.get(profileId)
  if (!profile) return
  const same = (m: ModelChoice) => m.provider === choice.provider && m.model === choice.model
  const recent = profile.recentModels ?? []
  if (recent[0] && same(recent[0])) return
  const recentModels = [choice, ...recent.filter((m) => !same(m))].slice(0, RECENT_MODELS)
  await updateProfile(profileId, { recentModels })
}

/**
 * Deletes a profile and its chats. The last profile can't be deleted, except by `last` (a linked bot
 * that left the registry), which puts a fresh seed in its place. `remote` is a deletion sync pulled
 * from another device, which needs no tombstone of its own.
 */
export async function deleteProfile(id: string, { remote = false, last = false } = {}) {
  const tables = [db.profiles, db.conversations, db.messages, db.tombstones]
  return db.transaction("rw", tables, async () => {
    const alone = (await db.profiles.count()) <= 1
    if (alone && !last) return false
    const ids = await conversationsOf(id).primaryKeys()
    await db.messages.where("conversationId").anyOf(ids).delete()
    await db.conversations.bulkDelete(ids)
    await db.profiles.delete(id)
    if (!remote) await db.tombstones.put({ id: `bot:${id}`, deletedAt: Date.now(), profileId: id })
    if (alone) await db.profiles.add(newProfile({}, []))
    return true
  })
}

/** A profile's chats, oldest activity first. */
export function conversationsOf(profileId: string) {
  return db.conversations
    .where("[profileId+updatedAt]")
    .between([profileId, Dexie.minKey], [profileId, Dexie.maxKey])
}

export async function createConversation(
  profileId: string,
  fields: Partial<Pick<Conversation, "title" | "projectId" | "mode" | "modelChoice">> = {},
): Promise<Conversation> {
  const now = Date.now()
  const conversation: Conversation = {
    id: randomId(),
    profileId,
    title: "New chat",
    hermesSessionId: `memento-${randomId()}`,
    createdAt: now,
    updatedAt: now,
    changedAt: now,
    ...fields,
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
