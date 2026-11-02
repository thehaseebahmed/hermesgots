import type { Conversation, Profile } from "@/lib/db"

/**
 * A transcript read that came back with nothing, as a bug report can carry it: which chat and
 * session it was, what the host said, and the build that asked. It is built by picking named
 * fields, and any free-form text it does carry — the host's message, a stack — has the bot's
 * address and key scrubbed out of it, so a paste can never take either to a support thread.
 */

/** How the read ended: the host refused it, the request never landed, or it answered with no rows. */
export type ReadEnding = "host" | "network" | "empty"

export interface DiagReadFailure {
  at: string
  app: string
  chat: {
    id: string
    session: string
    /** Rows this device holds for the chat — none, when there is nothing to draw. */
    stored: number
    /** This device holds only part of the host's transcript for it. */
    older?: true
  }
  bot: {
    id: string
    botId: string
    /** The plugin version this device remembers; null where none has answered yet. */
    pluginVersion: string | null
  }
  read: {
    /** The route the read went to, as the app names it. */
    endpoint: string
    ended: ReadEnding
    /** The host's status, when it answered with one. */
    status?: number
    /** The error envelope's `code`, when the host sent one. */
    code?: string
    name?: string
    message?: string
    stack?: string
  }
}

/** A host's message and a stack are read by a person, so each is cut to what a person will read. */
const MESSAGE_CAP = 300
const STACK_CAP = 4000

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined

const text = (value: unknown, cap: number): string | undefined =>
  typeof value === "string" && value ? value.slice(0, cap) : undefined

/** A free-form string with the bot's address and key taken out, however often they appear. */
const scrub = (value: string, secrets: string[]) =>
  secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join("<redacted>"), value)

export function describeReadFailure(input: {
  /** When the read failed. */
  at: number
  /** What it threw; absent where the host answered and the answer held no rows. */
  error?: unknown
  chat: Conversation
  profile: Profile
  /** Rows this device holds for the chat now. */
  stored: number
  endpoint: string
}): DiagReadFailure {
  const { at, error, chat, profile, stored, endpoint } = input
  const secrets = [profile.baseUrl, profile.baseUrl.replace(/\/+$/, ""), profile.apiKey]
  const status = field(error, "status")
  const code = field(error, "code")
  const built: DiagReadFailure = {
    at: new Date(at).toISOString(),
    app: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
    chat: {
      id: chat.id,
      session: chat.hermesSessionId,
      stored,
      ...(chat.olderThan ? { older: true as const } : {}),
    },
    bot: {
      id: profile.id,
      botId: profile.botId,
      pluginVersion: profile.pluginVersion ?? null,
    },
    read: {
      endpoint,
      // A read that answered and held nothing is "empty"; one that threw either reached the host
      // and was refused (it said a status) or never landed at all.
      ended: error === undefined ? "empty" : typeof status === "number" ? "host" : "network",
    },
  }
  if (typeof status === "number") built.read.status = status
  const named = text(code, MESSAGE_CAP)
  if (named) built.read.code = named
  const named2 = text(field(error, "name"), MESSAGE_CAP)
  if (named2) built.read.name = named2
  const message = text(
    error instanceof Error ? error.message : field(error, "message"),
    MESSAGE_CAP,
  )
  if (message) built.read.message = scrub(message, secrets)
  const stack = text(error instanceof Error ? error.stack : undefined, STACK_CAP)
  if (stack) built.read.stack = scrub(stack, secrets)
  return built
}

/** The record as the clipboard takes it: one JSON a support thread can read. */
export const formatReadFailure = (failure: DiagReadFailure) => JSON.stringify(failure, null, 2)
