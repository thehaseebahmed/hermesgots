import type { Conversation, Profile } from "@/lib/db"
import { RESUME_STAGES, type ResumeStage, type ResumeTrace } from "./resume-trace.ts"

/**
 * The device's own state as one JSON a bug report can carry: what build is running, what the
 * developer switches say, and for every bot its host's answers and its chats' shape. It is built
 * by picking named fields, so a key, a server address or a message's text can never ride along —
 * `scripts/test-diagnostics.mjs` pins that against a profile that carries them.
 */

/** A chat as the state names it: its shape and clocks, never what anyone said in it. */
export interface DiagChat {
  id: string
  title: string
  /** The bot's permanent Main thread. */
  main?: boolean
  session: string
  createdAt: string
  updatedAt: string
  changedAt: string
  /** This device holds only part of the host's transcript for it. */
  older?: boolean
  /** The moves triage recorded on the host for it (a Main thread's Moved markers). */
  moves?: number
  messages?: { user: number; assistant: number }
}

export interface DiagBot {
  id: string
  name: string
  botId: string
  /** Whether the bot has a server and a key to reach it with — never the address or the key. */
  configured: boolean
  disabled?: boolean
  muted?: boolean
  /** The plugin version this device remembers: the last read that answered. */
  pluginVersion: string | null
  /** The plugin version read now; null where the host couldn't be asked or didn't answer. */
  plugin: string | null
  /** The features the plugin advertises; null where the host couldn't be asked. */
  features: string[] | null
  /** The thread this device's pane last opened for the bot, as the pane itself reads it. */
  lastThread: string | null
  /** The thread storage holds for the pane, even where the pane refuses it. */
  lastStored: string | null
  /** Its Main thread, read by its own id; null where this device has no Main row for it. */
  main: DiagChat | null
  /** How many threads the bot has, counted through the index. */
  threads: number
  /** The newest chats, most recently touched first, as far back as the window reached; Main may
   * be among them. */
  chats: DiagChat[]
  /** Its own reads failed, so what sits above is what could be read around them. */
  unread?: true
}

export interface DiagDevice {
  at: string
  app: string
  minPlugin: string
  native: boolean
  /** The screen the state was taken on. */
  route: string
  /** The Dexie schema version this device is on. */
  schema: number
  developer: boolean
  botThreads: boolean
  /** The latest return to the foreground, timed; absent before this launch's first one. */
  resume?: DiagResume
  bots: DiagBot[]
}

/** One return to the foreground: when it happened, and where its stages landed. */
export interface DiagResume {
  /** When the return happened; absent when the trace carries no usable clock for it. */
  at?: string
  /** Stage -> the milliseconds since the return it landed at, in landing order. */
  stages: Partial<Record<ResumeStage, number[]>>
  /** Stage -> the requests the resume made there, where any were counted. */
  requests?: Partial<Record<ResumeStage, number>>
}

/** A title cut short: enough to recognise a chat, not a page of text. */
const TITLE = 80

const stamp = (ms: number) => new Date(ms).toISOString()

export function diagChat(
  chat: Conversation,
  messages?: { user: number; assistant: number },
): DiagChat {
  const built: DiagChat = {
    id: chat.id,
    title: chat.title.slice(0, TITLE),
    session: chat.hermesSessionId,
    createdAt: stamp(chat.createdAt),
    updatedAt: stamp(chat.updatedAt),
    changedAt: stamp(chat.changedAt),
  }
  if (chat.main) built.main = true
  if (chat.olderThan) built.older = true
  if (chat.moves?.length) built.moves = chat.moves.length
  if (messages) built.messages = messages
  return built
}

/** What this device knows about one bot's host and pane: null is nothing answered, never a guess. */
export interface DiagHost {
  /** Whether the bot could be called at all. */
  configured: boolean
  /** The plugin version this device remembers: the last read that answered. */
  pluginVersion: string | null
  /** The version read now. */
  plugin: string | null
  /** The features the plugin advertises. */
  features: string[] | null
  /** The thread the pane last opened for the bot, as the pane itself reads it. */
  lastThread: string | null
  /** The thread storage holds for the pane, even where the pane refuses it. */
  lastStored: string | null
}

export function diagBot(input: {
  profile: Profile
  host: DiagHost
  chats: DiagChat[]
  /** Main itself, read by its own id rather than from the window. */
  main: DiagChat | null
  /** How many threads the bot has, counted through the index. */
  threads: number
  /** Whether the bot's own reads failed, leaving what follows as what could be read. */
  unread?: boolean
}): DiagBot {
  const { profile, host, chats, main, threads, unread } = input
  const built: DiagBot = {
    id: profile.id,
    name: profile.name,
    botId: profile.botId,
    configured: host.configured,
    pluginVersion: host.pluginVersion,
    plugin: host.plugin,
    features: host.features,
    lastThread: host.lastThread,
    lastStored: host.lastStored,
    main,
    threads,
    chats,
  }
  if (unread) built.unread = true
  if (profile.disabled) built.disabled = true
  if (profile.muted) built.muted = true
  return built
}

/** The state as the sheet shows and the clipboard takes. */
export const formatDiagnostics = (device: DiagDevice) => JSON.stringify(device, null, 2)

/**
 * The trace as the dump carries it: each stage picked by name out of `RESUME_STAGES` and each
 * value copied only when it is really a number, so a poisoned trace can't ride a server address, a
 * key or message text into a bug report. An `at` that isn't a clock is left out entirely.
 */
export function diagResume(trace: ResumeTrace): DiagResume {
  const stages: Partial<Record<ResumeStage, number[]>> = {}
  const requests: Partial<Record<ResumeStage, number>> = {}
  for (const stage of RESUME_STAGES) {
    const offsets = trace.stages[stage]
    if (Array.isArray(offsets)) {
      const numbers = offsets.filter((one) => typeof one === "number" && Number.isFinite(one))
      if (numbers.length) stages[stage] = numbers
    }
    const count = trace.requests[stage]
    if (typeof count === "number" && Number.isFinite(count)) requests[stage] = count
  }
  const built: DiagResume = { stages }
  if (Number.isFinite(trace.at)) built.at = stamp(trace.at)
  if (Object.keys(requests).length) built.requests = requests
  return built
}
