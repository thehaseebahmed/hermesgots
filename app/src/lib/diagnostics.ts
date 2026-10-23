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
  /** Its messages, counted through the role index. */
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
  /** The plugin version its host last reported, and the one read now (null: it didn't answer). */
  pluginVersion?: string
  plugin?: string | null
  /** The features the plugin advertises, or null where the host couldn't be asked. */
  features?: string[] | null
  /** The thread this device's pane last opened for the bot, where it has one. */
  lastThread?: string | null
  /** Its Main thread, once this device has made or synced one. */
  main?: DiagChat
  /** How many threads it has; the threads themselves, oldest started first. */
  threads: number
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

/** What the host answered about one bot, where it could be asked at all. */
export interface DiagHost {
  plugin?: string | null
  features?: string[] | null
  lastThread?: string | null
}

export function diagBot(profile: Profile, chats: DiagChat[], host: DiagHost = {}): DiagBot {
  const main = chats.find((chat) => chat.main)
  const threads = chats.filter((chat) => !chat.main)
  const built: DiagBot = {
    id: profile.id,
    name: profile.name,
    botId: profile.botId,
    configured: Boolean(profile.baseUrl?.trim()) && Boolean(profile.apiKey),
    threads: threads.length,
    chats: threads,
  }
  if (profile.disabled) built.disabled = true
  if (profile.muted) built.muted = true
  if (profile.pluginVersion) built.pluginVersion = profile.pluginVersion
  if (host.plugin !== undefined) built.plugin = host.plugin
  if (host.features !== undefined) built.features = host.features
  if (host.lastThread !== undefined) built.lastThread = host.lastThread
  if (main) built.main = main
  return built
}

/** The state as the sheet shows and the clipboard takes. */
export const formatDiagnostics = (device: DiagDevice) => JSON.stringify(device, null, 2)
