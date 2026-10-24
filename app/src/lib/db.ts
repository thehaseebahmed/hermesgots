import Dexie, { type EntityTable, type Transaction } from "dexie"

import { BOTS, LEGACY_BOT_IDS } from "@/components/bots"
import { connectionKey } from "@/lib/connection"
import type { Compaction, ModelChange, Move, ProviderUsage, Skill } from "@/lib/hermes"
import type { SessionPipeline } from "@/lib/pipeline"
import type { PromptEntry } from "@/lib/prompt-library"
import { randomId } from "@/lib/utils"

export type ThemePreference = "system" | "light" | "dark"

export type BotSort = "recent" | "waiting" | "name" | "added"

export type LibrarySort = "new" | "old" | "az" | "za"

export interface Settings {
  id: "settings"
  /** A message sent while a reply runs steers it, instead of waiting in the queue. */
  steerByDefault?: boolean
  /** Reminds phone users to put the app away while a bot chat or code session runs. On by default. */
  breakReminders?: boolean
  /** Alt+1 to Alt+9 start a new chat with the bot added in that place. Off by default. */
  navShortcuts?: boolean
  /** The clock on this device's copy of the appearance record: a change made here, or one pulled. */
  appearanceAt?: number
  /**
   * The clock on this device's own edits to the account's prompt library — a save, a rename or a
   * delete. Sync's fingerprint reads this instead of the entries, so an edit asks for a pass without
   * every body being read and cloned on each one.
   */
  promptsAt?: number
  /** Shows the Developer section in Settings (tapping the version five times). */
  developer?: boolean
  /** The bot-first layout: bots in the sidebar, each chat a thread in its bot. Developer, local. */
  botThreads?: boolean
  /** Meetings: add a recording or transcript and read the host's notes. Developer, local. */
  meetings?: boolean
  /** AFK's workflow library: a project's Workflow row, its library and its editor. Developer, local. */
  afkWorkflows?: boolean
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
export const APPEARANCE_FIELDS = ["steerByDefault", "breakReminders", "navShortcuts"] as const

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
  /** The names and words its dictation is written with, sent with the start of every take. Synced. */
  vocabulary?: string[]
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
  /**
   * Every model this chat's calls ran on, oldest first, as the Gots plugin recorded them, so its
   * thread can show where the model changed. Local only; every device reads the same list.
   */
  modelChanges?: ModelChange[]
  /**
   * When the host compacted this chat's context, oldest first, so its thread can mark where. Local
   * only; every device reads the same list.
   */
  compactions?: Compaction[]
  /**
   * The messages triage moved out of this Main thread, oldest first, for its Moved markers. Local
   * only; every device reads the same list from the host.
   */
  moves?: Move[]
  /** Newest Hermes transcript row this device has caught up to. Local only; never synced. */
  hermesTip?: number
  /**
   * The agent's own todo list (its `todo_list` tool), the progress the plugin worked out with it, and
   * when this device last set it. Local only; every device reads it from the Gots plugin.
   */
  todos?: { revision: number; items: Todo[]; progress?: TodoProgress; at: number }
  /** A model the user picked for this chat from its host's configured ones; unset runs the bot's. */
  modelChoice?: ModelChoice
  /** The Hermes Project this chat is a session of (works in its own worktree). */
  projectId?: string
  /**
   * Started by AFK to work one of its project's tasks, on the host. Synced through the chat record
   * the plugin publishes, so every device marks the session the same; the user's own sessions never
   * carry it.
   */
  afk?: boolean
  /** When the user saved the session as a draft. Synced, so the plugin's cleanup spares it. */
  draftAt?: number
  /** The unsent text in this chat's composer. Synced through the chat record, so another device and a reinstall see it. */
  draftText?: string
  /** Marked done by the user, or by the plugin once its pull request merged; the composer gives way until it's reopened. */
  resolvedAt?: number
  /** Moved to the project's Discarded pile: its pull request closed and its branch deleted. */
  discardedAt?: number
  /** Its pushes are muted. Synced through the chat list, which is where the plugin reads it. */
  muted?: boolean
  /** The bot's Main thread: its permanent chat, which can't be deleted or discarded. Synced. */
  main?: boolean
  /** Permission mode. The plugin holds it live; the user's saved pick also travels in the chat record. */
  mode?: SessionMode
  /**
   * The session's worktrees (one per repo of the project, all on `branch`), from the plugin, and
   * the line that tells the agent where they are. Local only; no path reaches the UI.
   */
  worktree?: { branch: string; repos: { name: string; branch: string }[]; instructions: string }
  /**
   * The stages a staged AFK task ran in — Build, Gate, Critique — as the plugin recorded them on the
   * session itself, so the session still says how it got here once its task is finished. Local only;
   * every device reads the same record.
   */
  pipeline?: SessionPipeline | null
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
 * sessions made before 0.42 stored Theseus as a mode of its own, and those read as Auto.
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
  /** How far it sits under its parents, as the plugin worked it out; 0 when it is a root. */
  depth: number
}

/** A todo list's progress, as the plugin worked it out: a cancelled item counts for neither. */
export interface TodoProgress {
  done: number
  total: number
}

/** How deep a subtask may indent, the same cap the plugin states each item's depth under. */
export const MAX_TODO_DEPTH = 3

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
export type MessageStatus = "triaging" | "queued" | "streaming" | "done" | "error" | "stopped"

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
  /** The model this device started the turn with, when the chat had one picked. Local only. */
  model?: string
  stats?: MessageStats
  createdAt: number
  /** The Hermes transcript row a user message was matched to, once the device has seen it. */
  hermesRowId?: number
  /**
   * When that row was written, on the host's clock. A compaction re-emits the carried tail under fresh
   * row ids with their times untouched, so this, not the row id, is what identifies a turn the device
   * already holds when a later catch-up meets it again.
   */
  hermesAt?: number
  /** The run behind a reply and its last event seen, so a dropped stream can pick up again. */
  runId?: string
  runSeq?: number
  /** A queued message the Gots plugin holds, which starts it on the host when the run ends. */
  hostQueued?: boolean
  /** The plugin holds the queue until the user sends: a stopped or refused run came before it. */
  queuePaused?: boolean
}

/**
 * A local deletion sync hasn't pushed yet. One table holds every kind, and the id says which: a bot's
 * is `bot:<profileId>`, a chat's `chat:<conversationId>` and a library entry's `prompt:<entryId>`.
 * A bot and a chat belong to a profile, so their tombstones carry it — the sync's readers go by it —
 * while an entry is the account's rather than a bot's, which is why only that kind has none. The
 * shape is what keeps the profile there: a `bot:` or `chat:` tombstone without one doesn't compile,
 * rather than syncing to nothing.
 */
interface TombstoneOf<Id extends string> {
  id: Id
  deletedAt: number
}

/** A bot's deletion, named by the bot it deletes; its id is the profile's. */
export interface BotTombstone extends TombstoneOf<`bot:${string}`> {
  profileId: string
}

/** A chat's deletion, named by the chat; the profile it belonged to rides along. */
export interface ChatTombstone extends TombstoneOf<`chat:${string}`> {
  profileId: string
}

/** A prompt library entry's deletion: the account's, so it names no bot. */
export interface PromptTombstone extends TombstoneOf<`prompt:${string}`> {
  profileId?: never
}

export type Tombstone = BotTombstone | ChatTombstone | PromptTombstone

/** Whether a tombstone is a bot's: the id it carries is what says which kind a row is. */
function isBotTombstone(row: Tombstone): row is BotTombstone {
  return row.id.startsWith("bot:")
}

/** Whether a tombstone is a chat's, read the same way. */
function isChatTombstone(row: Tombstone): row is ChatTombstone {
  return row.id.startsWith("chat:")
}

/**
 * The bot tombstones this device still holds. One table keeps every kind, so a reader narrows by the
 * id it reads — and from there on the record's profile is a `string`, not something to guard again.
 */
export async function botTombstones(): Promise<BotTombstone[]> {
  const rows = await db.tombstones.where("id").startsWith("bot:").toArray()
  return rows.filter(isBotTombstone)
}

/** The chat tombstones, each with the profile its chat belonged to. */
export async function chatTombstones(): Promise<ChatTombstone[]> {
  const rows = await db.tombstones.where("id").startsWith("chat:").toArray()
  return rows.filter(isChatTombstone)
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
  /**
   * What made the take: `stream` is a value older builds wrote for a take heard while it was
   * spoken, and this build no longer writes it.
   */
  kind?: "pieces" | "stream"
  /** Where the caret was when the take began, so a restored take lands where it was left. */
  caret?: number
}

/**
 * A meeting being recorded in the app, kept on the device as it records (a chunk every few
 * seconds), so a page closed mid-meeting loses at most the last few seconds. It goes once the host
 * has the recording, or when the user discards it.
 */
export interface SavedMeetingRecording {
  id: string
  profileId: string
  projectId?: string
  /** The recorder's MIME type, without parameters. */
  type: string
  chunks: Blob[]
  /** How long it has run, with the pauses left out. */
  ms: number
  startedAt: number
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

/** The skills one bot last listed, kept so the composer's `/` menu opens on them (`skills.ts`). */
export interface CachedSkills {
  /** The connection the list belongs to (one bot's server and key). */
  id: string
  skills: Skill[]
}

/** Carries a default for every appearance switch, so reading one never needs a fallback. */
export const DEFAULT_SETTINGS: Settings & Appearance = {
  id: "settings",
  steerByDefault: false,
  breakReminders: true,
  navShortcuts: false,
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
  skills: EntityTable<CachedSkills, "id">
  meetingRecordings: EntityTable<SavedMeetingRecording, "id">
  prompts: EntityTable<PromptEntry, "id">
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

// v13: indexes for what was found by reading every row: streaming replies at launch, a chat by its
// Hermes session (push taps, change events), a thread's replies by role, and the newest change.
db.version(13).stores({
  conversations: "id, updatedAt, [profileId+updatedAt], projectId, hermesSessionId, changedAt",
  messages: "id, conversationId, [conversationId+createdAt], status, [conversationId+role]",
})

// v14: BenchLM overall rankings replace the coding cache. The coding table is dropped; the cache is
// disposable (24-hour TTL), so the next picker open refetches the overall payload.
db.version(14).stores({ codingRankings: null, overallRankings: "id" })

// v15: a todo list carries the progress and the depths the plugin worked out with it. A list stored
// before that has neither, and nothing here may work them out, so it goes: the next read brings the
// list back with them.
db.version(15).upgrade((tx) =>
  tx
    .table("conversations")
    .filter((conversation: Record<string, unknown>) => "todos" in conversation)
    .modify((conversation: Record<string, unknown>) => {
      delete conversation.todos
    }),
)

// v16: the skills the bot last listed, so the composer's `/` menu opens on them offline.
db.version(16).stores({ skills: "id" })

// v17: a chat always shows the agent's work, so the switch that hid it goes from the settings row
// rather than riding along in every save.
db.version(17).upgrade((tx) =>
  tx
    .table("settings")
    .filter((settings: Record<string, unknown>) => "simplifiedChats" in settings)
    .modify((settings: Record<string, unknown>) => {
      delete settings.simplifiedChats
    }),
)

// v18: a meeting recorded in the app is kept on the device while it records.
db.version(18).stores({ meetingRecordings: "id" })

// v19: the message the host is deciding on is triaging, not routing — the same state, named for the
// decision the host makes, which the GLOSSARY has always called triage. The field is indexed, so the
// rows a closed page left behind are read through that index and rewritten, rather than left as a
// name nothing checks for.
db.version(19).upgrade((tx) =>
  tx.table("messages").where("status").equals("routing").modify({ status: "triaging" }),
)

// v20: a Main row made before the flag existed read as a plain thread and took Main's whole
// behaviour with it — the shape a real device dump showed on two of four bots.
db.version(20).upgrade((tx) =>
  tx
    .table("conversations")
    .filter(
      (conversation: Record<string, unknown>) =>
        typeof conversation.id === "string" &&
        conversation.id.startsWith("main-") &&
        !conversation.main,
    )
    .modify({ main: true }),
)

// v21: the account's prompts, kept where the bots are and synced as a document of their own.
db.version(21).stores({ prompts: "id" })

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

/**
 * Takes the appearance record another device wrote, clock and all, so this one doesn't push it back.
 * A record can name a switch this build doesn't have — one that was retired, or one from a newer
 * build — and writing that name back would put a field nothing reads in this device's settings row.
 */
export async function adoptAppearance(
  value: Partial<Record<keyof Appearance, unknown>>,
  at: number,
) {
  const known: Partial<Appearance> = {}
  for (const field of APPEARANCE_FIELDS) {
    const on = value[field]
    if (typeof on === "boolean") known[field] = on
  }
  await saveSettings({ ...known, appearanceAt: at })
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
    db.skills,
    db.meetingRecordings,
  ]
  return db.transaction("rw", tables, async () => {
    const alone = (await db.profiles.count()) <= 1
    if (alone && !last) return false
    const profile = await db.profiles.get(id)
    const ids = await conversationsOf(id).primaryKeys()
    await db.messages.where("conversationId").anyOf(ids).delete()
    // Unsent text and recordings, the chats' and the bot's new thread's.
    const keys = [...ids.map((chat) => `c:${chat}`), `new:${id}`]
    await db.drafts.bulkDelete(keys)
    await db.dictations.bulkDelete(keys)
    await db.meetingRecordings.filter((recording) => recording.profileId === id).delete()
    // The bot's own device state, keyed by its server: a twin bot sharing the connection refills it.
    if (profile) await db.skills.delete(connectionKey(profile))
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

/** A bot's Main thread has an id every device derives, so two devices never make two. */
export const mainThreadId = (profileId: string) => `main-${profileId}`

/** The bot a Main thread's id names, or undefined for any other chat. */
export const mainThreadProfile = (id: string) =>
  id.startsWith("main-") ? id.slice("main-".length) : undefined

/**
 * Makes the bot's Main thread the first time it's asked for. Its change clock is 0, so a record
 * another device already synced always wins the merge over this empty copy.
 */
export async function ensureMainThread(profileId: string): Promise<Conversation> {
  const id = mainThreadId(profileId)
  return db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(id)
    if (existing) {
      // A Main row that lost the flag reads as a plain thread and takes Main's whole behaviour
      // with it, so it is healed here — the one place that owns the row.
      if (existing.main) return existing
      await updateConversation(id, { main: true })
      return (await db.conversations.get(id)) ?? existing
    }
    const now = Date.now()
    const conversation: Conversation = {
      id,
      profileId,
      title: "Main",
      titleEdited: true,
      hermesSessionId: `memento-${id}`,
      createdAt: now,
      updatedAt: now,
      changedAt: 0,
      main: true,
    }
    await db.conversations.add(conversation)
    return conversation
  })
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
    // Main goes only when another device says so (`remote`), never from here.
    if (conversation?.main && !remote) return
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
    db.skills,
    db.meetingRecordings,
  ]
  await db.transaction("rw", tables, async () => {
    await Promise.all(tables.map((table) => table.clear()))
    await db.profiles.add(newProfile({}, []))
  })
}
