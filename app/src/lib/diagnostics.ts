import type { Conversation, Profile } from "@/lib/db"

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
  /** Its Main thread, read by its own id; null where this device has no Main row for it. */
  main: DiagChat | null
  /** How many threads the bot has, counted through the index. */
  threads: number
  /** The threads themselves, most recently touched first, as far back as the window reached. */
  chats: DiagChat[]
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
  bots: DiagBot[]
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
}

export function diagBot(input: {
  profile: Profile
  host: DiagHost
  chats: DiagChat[]
  /** Main itself, read by its own id rather than from the window. */
  main: DiagChat | null
  /** How many threads the bot has, counted through the index. */
  threads: number
}): DiagBot {
  const { profile, host, chats, main, threads } = input
  const built: DiagBot = {
    id: profile.id,
    name: profile.name,
    botId: profile.botId,
    configured: host.configured,
    pluginVersion: host.pluginVersion,
    plugin: host.plugin,
    features: host.features,
    lastThread: host.lastThread,
    main,
    threads,
    chats,
  }
  if (profile.disabled) built.disabled = true
  if (profile.muted) built.muted = true
  return built
}

/** The state as the sheet shows and the clipboard takes. */
export const formatDiagnostics = (device: DiagDevice) => JSON.stringify(device, null, 2)
