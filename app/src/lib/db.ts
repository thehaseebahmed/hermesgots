import Dexie, { type EntityTable, type Transaction } from "dexie"

import { BOTS, LEGACY_BOT_IDS } from "@/components/bots"
import type { ProviderUsage } from "@/lib/hermes"
import { randomId } from "@/lib/utils"

export type ThemePreference = "system" | "light" | "dark"

export type BotSort = "recent" | "waiting" | "name" | "added"

export type LibrarySort = "new" | "old" | "az" | "za"

export interface Settings {
  id: "settings"
  /** Plain chats leave out context use, reply stats and tool calls; project sessions show them. */
  simplifiedChats: boolean
  /** A message sent while a reply runs steers it, instead of waiting in the queue. */
  steerByDefault?: boolean
  /** Reminds phone users to put the app away while a bot chat or code session runs. On by default. */
  breakReminders?: boolean
  /** The clock on this device's copy of the appearance record: a change made here, or one pulled. */
  appearanceAt?: number
  /** Shows the Developer section in Settings (tapping the version five times). */
  developer?: boolean
  /** The bot-first layout: bots in the sidebar, each chat a thread in its bot. Developer, local. */
  botThreads?: boolean
  /** Meetings: record or add a meeting and read its notes (a design mock). Developer, local. */
  meetings?: boolean
  /** How the bot-threads sidebar orders the bots; unset is `recent`. Local. */
  botSort?: BotSort
  /** Whether the sidebar is shrunk to icons on tablet and wider; unset is expanded. Local. */
  sidebarCollapsed?: boolean
  /** How the Library tab orders folders and files; unset is `new`. Local. */
  librarySort?: LibrarySort
  activeProfileId?: string
  /** When sync last finished without an error. */
  syncedAt?: number
  /** Finished the first-run setup. */
  onboarded?: boolean
  /** Soft-wrap in tool output; unset until the user flips it (wrapped by default). */
  wrapToolOutput?: boolean
  /** Bots whose old Netlify chat list was moved onto their Gots plugin and deleted. */
  movedChats?: string[]
  /** This device's Web Push identity, local only: its id, its VAPID key pair and whether it's on. */
  push?: { device: string; vapidKey: string; vapidPublic: string; on: boolean }
  /** The Android app's push identity, local only: Firebase gives the token, this is its device id. */
  fcm?: { device: string; on: boolean; trying?: boolean }
  /** Which categories of push this device wants; unset ones follow `PUSH_CATEGORIES`. Local only. */
  pushCategories?: Partial<Record<string, boolean>>
}

/**
 * The Appearance section's switches, which follow the account; the colour mode isn't one of them,
 * since next-themes keeps it on the device. Sync carries them as the `settings` document's one
 * record and the fingerprint watches them, so this list is the one place that says what syncs.
 */
export const APPEARANCE_FIELDS = ["simplifiedChats", "steerByDefault", "breakReminders"] as const

/** Those switches as sync reads them, present rather than optional, so a read needs no fallback. */
export type Appearance = Required<Pick<Settings, (typeof APPEARANCE_FIELDS)[number]>>

/** A Hermes profile Gots can talk to. Its Gots plugin registers it (see `registry.ts`). */
export interface Profile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** Which of the bot characters represents this profile. */
  botId: string
  /** The window the bot holds for its model, written automatically when the model is looked up. */
  contextWindow?: number
  /** `provider/model` the held window is for; another model's window is never shown for it. */
  contextModel?: string
  /** Whether the model takes images, per models.dev; unset when it doesn't list the model. */
  imageInput?: boolean
  /** The model new turns run on when a chat hasn't picked its own; unset runs the host's. */
  modelChoice?: ModelChoice
  /** The last few models picked on this bot, newest first, for switching back quickly. */
  recentModels?: ModelChoice[]
  /** The linked host that registered it; unset for a bot added by hand before linking. */
  hostId?: string
  /** Its pushes are muted: nothing it says reaches any device. Synced; the plugin holds the mute. */
  muted?: boolean
  /** Turned off in the app: hidden, and nothing checks on it. Local copy of the registry's flag. */
  disabled?: boolean
  /** When its host last checked in with the registry. Local only. */
  seenAt?: number
  /** The Gots plugin version its host last reported. Local only. */
  pluginVersion?: string
  /** The host's main model as last read by any device, shown while it's read again. */
  hostModel?: ModelChoice
  /** The provider's account-usage windows, local only; read from the Gots plugin. */
  providerUsage?: ProviderUsage
  /** A dismissed limit-notice key (provider + window label + reset), local only. */
  limitDismissed?: string
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
   * The session's latest model call, as the Gots plugin recorded it: its prompt tokens, the
   * model that ran it, and the window Hermes compresses against. Local only; every device reads it
   * from the plugin.
   */
  liveContext?: { tokens: number; window?: number; model?: string }
  /** Newest Hermes transcript row this device has caught up to. Local only; never synced. */
  hermesTip?: number
  /**
   * The agent's own todo list (its `todo_list` tool) and when this device last set it. Local only;
   * every device reads it from the Gots plugin.
   */
  todos?: { revision: number; items: Todo[]; at: number }
  /** A model the user picked for this chat from its host's configured ones; unset runs the bot's. */
  modelChoice?: ModelChoice
  /** The Hermes Project this chat is a session of (works in its own worktree). */
  projectId?: string
  /** When the user saved the session as a draft. Synced, so the plugin's cleanup spares it. */
  draftAt?: number
  /** Marked done by the user, or by the plugin once its pull request merged; the composer gives way until it's reopened. */
  resolvedAt?: number
  /** Moved to the project's Discarded pile: its pull request closed and its branch deleted. */
  discardedAt?: number
  /** Its pushes are muted. Synced through the chat list, which is where the plugin reads it. */
  muted?: boolean
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
  /**
   * Every pull request from the session's branches, newest first, the ones it already finished
   * included, and when they were last read. Local only.
   */
  prs?: PullRequestRef[]
  /**
   * How many files the session filed in its library, and when they were counted. Local only;
   * every device reads them from the Gots plugin.
   */
  library?: { count: number; at: number }
}

/** How much a project session may do without asking. */
export type SessionMode = "accept_edits" | "auto" | "plan"

/**
 * A session's mode as the app works with it. An unset mode is Accept edits, Hermes's own behaviour;
 * sessions made before 0.42 stored Theseus as a mode of its own, and those read as Auto, which is
 * what carries a goal on.
 */
export function sessionMode(mode: SessionMode | "theseus" | undefined): SessionMode {
  if (mode === "theseus") return "auto"
  return mode === "auto" || mode === "plan" ? mode : "accept_edits"
}

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

/** The states a pull request is still live in: open, or a draft waiting for review. */
export const LIVE_PR_STATES: PrState[] = ["open", "draft"]

/** Whether a pull request is one of a session's live ones. */
export const prIsLive = (pr: Pick<PullRequestRef, "state">) => LIVE_PR_STATES.includes(pr.state)

/** A pull request's identity among a session's: what GitHub closes, and what a list keys it by. */
export const prKey = (pr: Pick<PullRequestRef, "repo" | "number">) => `${pr.repo}#${pr.number}`

/** A session's pull requests, newest number first. */
export const byNewestPr = (a: PullRequestRef, b: PullRequestRef) =>
  b.number - a.number || a.repo.localeCompare(b.repo)

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
  /** Hermes's own time for the request, which tells one request from an identical later one. */
  askedAt?: number
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

/** The agent's questions (Hermes's `clarify` tool, served by the Gots plugin). */
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
  /** A photo's own size, so a viewer can hold its box before it's read. */
  width?: number
  height?: number
  /** Where the Gots plugin saved it on the Hermes host. */
  path?: string
}

/** Something the user added to a reply while it ran, which Hermes handed the agent mid-turn. */
export interface Steer {
  id: string
  text: string
  /** Where in the reply's text it was sent, so it sits there in the thread. */
  contentOffset: number
  at: number
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
  /** A reply's steers, in order. */
  steers?: Steer[]
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
  /** A queued message the Gots plugin holds, which starts it on the host when the run ends. */
  hostQueued?: boolean
  /** The plugin holds the queue until the user sends: a stopped or refused run came before it. */
  queuePaused?: boolean
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

/**
 * Unsent composer text, kept on this device only: `c:<conversation id>` for a chat or session,
 * `new` for the new chat screen and `new:<profile id>` for a bot's new thread.
 */
export interface Draft {
  id: string
  text: string
  at: number
}

/** A piece of a recording, cut at a pause; `text` is null until the host has transcribed it. */
export interface DictationPiece {
  blob: Blob
  text: string | null
}

/**
 * A recording not yet turned into text, kept on this device under its composer's draft key, so a
 * reload, a failed host or leaving the chat doesn't lose it.
 */
export interface SavedDictation {
  id: string
  pieces: DictationPiece[]
  at: number
}

/** The models.dev catalog cached on this device: the registry, its ETag and when it was fetched. */
export interface ModelsDevCatalog {
  id: "catalog"
  /** The registry itself; its shape lives in `models.ts`. */
  data: unknown
  etag: string
  fetchedAt: number
}

/** BenchLM overall rankings cached on this device, with a 24-hour freshness window. */
export interface OverallRankings {
  id: "overall"
  /** The rankings payload; its shape lives in `rankings.ts`. */
  data: unknown
  fetchedAt: number
}

/** Carries a default for every appearance switch, so reading one never needs a fallback. */
export const DEFAULT_SETTINGS: Settings & Appearance = {
  id: "settings",
  simplifiedChats: true,
  steerByDefault: false,
  breakReminders: true,
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
  drafts: EntityTable<Draft, "id">
  modelsDevCatalog: EntityTable<ModelsDevCatalog, "id">
  overallRankings: EntityTable<OverallRankings, "id">
  dictations: EntityTable<SavedDictation, "id">
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

// v6: run history comes from the Gots plugin on the Hermes server, not from each device.
db.version(6).stores({ cronRuns: null })

// v7: project sessions, listed per project.
db.version(7).stores({ conversations: "id, updatedAt, [profileId+updatedAt], projectId" })

// v8: every bot keeps its chats on its Gots plugin, so the per-bot flag for it goes.
db.version(8).upgrade((tx) =>
  tx
    .table("profiles")
    .toCollection()
    .modify((profile: Record<string, unknown>) => {
      delete profile.pluginChats
    }),
)

// v9: every composer keeps its unsent text, so drafts get their own table.
db.version(9)
  .stores({ drafts: "id" })
  .upgrade(async (tx) => {
    const conversations = tx.table("conversations")
    const left = await conversations.filter((c) => typeof c.draft === "string").toArray()
    await tx
      .table("drafts")
      .bulkPut(
        left
          .filter((c) => c.draft.trim())
          .map((c) => ({ id: `c:${c.id}`, text: c.draft, at: Date.now() })),
      )
    await conversations
      .filter((c) => "draft" in c)
      .modify((conversation: Record<string, unknown>) => {
        delete conversation.draft
      })
  })

// v10: the models.dev catalog is cached on the device, with a 24-hour freshness window.
db.version(10).stores({ modelsDevCatalog: "id" })

// v11: BenchLM rankings cached on the device, with a 24-hour freshness window.
db.version(11).stores({ codingRankings: "id" })

// v12: a recording waiting for its text is kept, under its composer's draft key.
db.version(12).stores({ dictations: "id" })

// v14: BenchLM overall rankings replace the coding cache. The coding table is dropped; the cache is
// disposable (24-hour TTL), so the next picker open refetches the overall payload.
db.version(14).stores({ codingRankings: null, overallRankings: "id" })

// v13: indexes for what was found by reading every row: streaming replies at launch, a chat by its
// Hermes session (push taps, change events), a thread's replies by role, and the newest change.
db.version(13).stores({
  conversations: "id, updatedAt, [profileId+updatedAt], projectId, hermesSessionId, changedAt",
  messages: "id, conversationId, [conversationId+createdAt], status, [conversationId+role]",
})

db.on("populate", (tx) => seedProfile(tx))

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }
}

export async function saveSettings(patch: Partial<Omit<Settings, "id">>) {
  const stored = await db.settings.get("settings")
  // Every screen reads settings live, so a write that changes nothing would wake them all.
  const changed =
    !stored ||
    (Object.keys(patch) as (keyof typeof patch)[]).some(
      (key) => JSON.stringify(stored[key]) !== JSON.stringify(patch[key]),
    )
  if (changed) await db.settings.put({ ...DEFAULT_SETTINGS, ...stored, ...patch, id: "settings" })
}

/** Saves an appearance switch; the clock moves so sync carries the change to the account's devices. */
export async function saveAppearance(patch: Partial<Appearance>) {
  await saveSettings({ ...patch, appearanceAt: Date.now() })
}

/** Takes the appearance record another device wrote, clock and all, so this one doesn't push it back. */
export async function adoptAppearance(value: Appearance, at: number) {
  await saveSettings({ ...value, appearanceAt: at })
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
  const tables = [
    db.profiles,
    db.conversations,
    db.messages,
    db.tombstones,
    db.drafts,
    db.dictations,
  ]
  return db.transaction("rw", tables, async () => {
    const alone = (await db.profiles.count()) <= 1
    if (alone && !last) return false
    const ids = await conversationsOf(id).primaryKeys()
    await db.messages.where("conversationId").anyOf(ids).delete()
    // Unsent text and recordings, the chats' and the bot's new thread's.
    const keys = [...ids.map((chat) => `c:${chat}`), `new:${id}`]
    await db.drafts.bulkDelete(keys)
    await db.dictations.bulkDelete(keys)
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
  const tables = [db.conversations, db.messages, db.tombstones, db.drafts, db.dictations]
  await db.transaction("rw", tables, async () => {
    const conversation = await db.conversations.get(id)
    await db.messages.where("conversationId").equals(id).delete()
    await db.drafts.delete(`c:${id}`)
    await db.dictations.delete(`c:${id}`)
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
  const tables = [
    db.conversations,
    db.messages,
    db.settings,
    db.profiles,
    db.tombstones,
    db.vault,
    db.drafts,
    db.dictations,
  ]
  await db.transaction("rw", tables, async () => {
    await Promise.all(tables.map((table) => table.clear()))
    await db.profiles.add(newProfile({}, []))
  })
}
