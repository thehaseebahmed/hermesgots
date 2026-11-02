/**
 * The runs behind a chat's routine messages (ADR 0081): which routine spoke while the bot worked,
 * and the Hermes session its run wrote. A routine's message is drawn as the bot's own, and the chip
 * it carries opens that run's transcript.
 *
 * The read is the plugin's, not the transcript's: a compaction re-emits carried rows under fresh row
 * ids while the delivery's display metadata survives, so only the host can say which row a routine's
 * message is drawn at now — and why a message the answer doesn't name draws no chip at all.
 */
import { useEffect, useState } from "react"

import { connectionKey, hasServer, serverConfig } from "@/lib/connection"
import { usePluginFeatureOn, type PluginServer } from "@/lib/features"
import { ROUTINES_MS } from "@/lib/freshness"
import { getRoutineMessages, type HermesConfig, type RoutineMessage } from "@/lib/hermes"
import { ROUTINE_KIND } from "@/lib/routine-message"
import { usePoll } from "@/lib/poll"
import { createStore } from "@/lib/store"
import { tracked } from "@/lib/tracked"

/** What a bot's plugin advertises when a routine's message can stand in a chat, with the route
 * naming the run behind it: the same wire string the row's display kind is, as the plugin has it. */
export const ROUTINE_MESSAGE_FEATURE = ROUTINE_KIND

/** One routine's message as the host names it, keyed by the row it is drawn at. */
export type RoutineRun = RoutineMessage

/** A chat with no routine message in it, as the same value on every render. */
const NONE: Map<number, RoutineRun> = new Map()

/** The answer per chat, by connection and Hermes session. Only a real answer replaces one. */
const answers = createStore<ReadonlyMap<string, Map<number, RoutineRun>>>(new Map())

/** The read in flight per chat, so the rows of one thread mounting together cost one request. */
const inFlight = new Map<string, Promise<void>>()

/** When each chat was answered, which is the one clock its freshness is read on. */
const taken = new Map<string, number>()

/** Chats with a routine message on screen, so one of them polls for the chat rather than each. */
const watching = new Map<string, number>()

/** A row a chat was asked about again, so a routine the host never names isn't asked for twice. */
const askedRows = new Set<string>()

/** Rows remembered for a second ask: a delivery no routine could be attributed to is never named. */
const ASKED_ROWS = 512

const keyOf = (config: HermesConfig, sessionId: string) => `${connectionKey(config)}\n${sessionId}`

/**
 * Asks a chat's bot for its routine messages, once per chat unless `again`. A read that fails keeps
 * whatever answer is held and nothing is thrown into the screen: a chat without the plugin simply
 * draws no chip.
 */
function read(config: HermesConfig, sessionId: string, again = false) {
  const key = keyOf(config, sessionId)
  const running = inFlight.get(key)
  if (running) return running
  const fresh = Date.now() - (taken.get(key) ?? 0) < ROUTINES_MS
  if (!again && answers.get().has(key) && fresh) return Promise.resolve()
  taken.set(key, Date.now())
  const read = getRoutineMessages(config, sessionId)
    .then((rows) =>
      answers.set(new Map(answers.get()).set(key, new Map(rows.map((one) => [one.row, one])))),
    )
    // A blip, a host that is away or a plugin without the route: the next mount asks again.
    .catch(() => void taken.delete(key))
    .finally(() => {
      if (inFlight.get(key) === read) inFlight.delete(key)
    })
  inFlight.set(key, read)
  return read
}

/**
 * The runs behind a chat's routine messages, keyed by the row each is drawn at, read once per chat
 * while the thread is on screen. Empty while the bot's plugin doesn't advertise `routine_message` —
 * nothing is asked of a host that has no such route — and asked for a chat with no routine message
 * too, since only the answer says which rows are one.
 */
export function useRoutineRuns(
  config: PluginServer,
  sessionId: string | undefined,
): Map<number, RoutineRun> {
  const server = serverConfig(config)
  const { baseUrl, apiKey } = server
  const on = usePluginFeatureOn(config, ROUTINE_MESSAGE_FEATURE)
  const key = hasServer(server) && sessionId ? keyOf(server, sessionId) : ""
  const answer = answers.use().get(key)
  // One poll per chat: a thread with ten routine messages in it watches the chat once.
  const first = useFirstWatcher(key)
  usePoll(
    () => {
      if (sessionId) void read(server, sessionId)
    },
    false,
    [baseUrl, apiKey, sessionId],
    { active: on && Boolean(key) && first },
  )
  return answer ?? NONE
}

/** Whether this is the one message of a chat that polls for it, counted as it mounts and unmounts. */
function useFirstWatcher(key: string) {
  const [first] = useState(() => {
    if (!key) return false
    watching.set(key, (watching.get(key) ?? 0) + 1)
    return watching.get(key) === 1
  })
  useEffect(() => {
    if (!first || !key) return
    return () => {
      const left = (watching.get(key) ?? 1) - 1
      if (left > 0) watching.set(key, left)
      else watching.delete(key)
    }
  }, [first, key])
  return first
}

/**
 * Asks a chat's runs again, for a routine's message the answer held doesn't name — one the bot
 * delivered since the read was taken, which a thread already on screen would otherwise never see a
 * chip on. Asked once per row: a delivery no routine could be attributed to is never named by the
 * route, and asking after it on every render would be a request with no answer to come.
 */
export function askRoutineRuns(config: PluginServer, sessionId: string | undefined, row: number) {
  const server = serverConfig(config)
  if (!hasServer(server) || !sessionId) return
  const mark = `${keyOf(server, sessionId)}|${row}`
  if (askedRows.has(mark)) return
  if (askedRows.size >= ASKED_ROWS) askedRows.clear()
  askedRows.add(mark)
  void read(server, sessionId, true)
}

/** What a routine's message needs to be drawn: the bot to read with, and the chat's own session. */
export interface RoutineChat {
  server: HermesConfig
  sessionId: string
}

/** The chat's bot and Hermes session, read once per chat and shared by every message of it. */
const chats = new Map<string, RoutineChat | null>()
const chatReads = new Map<string, Promise<void>>()

/**
 * The chat's own bot and Hermes session, as this device holds them — null for a chat whose bot is
 * gone, is turned off, or is keyless (Hermes knows no session without a key). Read once per chat: a
 * thread mounts a message at a time, and each would otherwise cost its own reads of the device.
 */
export function useRoutineChat(conversationId: string): RoutineChat | null {
  const [chat, setChat] = useState<RoutineChat | null>(() => chats.get(conversationId) ?? null)
  useEffect(() => {
    let stale = false
    const pending =
      chatReads.get(conversationId) ??
      tracked(conversationId).then((found) => {
        chats.set(
          conversationId,
          found
            ? { server: serverConfig(found.profile), sessionId: found.conversation.hermesSessionId }
            : null,
        )
        chatReads.delete(conversationId)
      })
    chatReads.set(conversationId, pending)
    void pending.then(() => {
      if (!stale) setChat(chats.get(conversationId) ?? null)
    })
    return () => {
      stale = true
    }
  }, [conversationId])
  return chat
}
