import { useEffect, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { READ_TIMEOUT_MS, RUNS_MS, SAFETY_MS } from "@/lib/freshness"
import { quietly } from "@/lib/report"
import { db } from "@/lib/db"
import { getLiveRuns, type LiveRunStatus, type LiveRuns, type WaitingReason } from "@/lib/hermes"
import { chatOnScreen, connectionKey, isLive, onChanges } from "@/lib/live"
import { closedSession, endedSessions } from "@/lib/session-work"
import { markResume } from "@/lib/resume-trace"

export type { WaitingReason }
// The wait's sentence is a rule of its own (`wait-text.ts`), so a screen with no DOM can read it too.
export { reasonText } from "@/lib/wait-text"

/** A session of any kind — a project's, a chat's, a canvas's — that waits for the user. */
export interface WaitingSession {
  sessionId: string
  title: string
  reason: WaitingReason
  project?: string
}

type Found = LiveRuns["waiting"]
type Server = { baseUrl: string; apiKey: string }

/**
 * What every bot's server reports of its runs (`runs/live`): which sessions run and which wait on the
 * user, by Hermes session id. One poll for the whole app, shared by every screen that reads it, so
 * the sidebar, a project's sessions and an open chat see the same answer at the same moment. A
 * server that streams its changes is asked when it says a run changed, and now and then anyway; the
 * rest are asked every few seconds.
 */
let answers = new Map<string, LiveRuns>()
let found: Found = {}
let running: Record<string, LiveRunStatus> = {}
// The subagents each session still runs, merged across every bot's server like `running`.
let subagents: Record<string, number> = {}
// The sessions still owed a wake turn — a finished subagent the host hasn't resumed the chat for
// yet — merged the same way, so no screen reads a session at rest in that window.
let waking: Record<string, number> = {}
let servers: Server[] = []
const listeners = new Set<() => void>()
let timer: number | undefined
let rounds = 0
const NO_RUNS: Record<string, LiveRunStatus> = {}

function notify() {
  found = Object.assign(
    {},
    ...servers.map((server) => answers.get(connectionKey(server))?.waiting ?? {}),
  )
  running = Object.assign({}, ...[...answers.values()].map((answer) => answer.sessions))
  subagents = Object.assign({}, ...[...answers.values()].map((answer) => answer.subagents))
  waking = Object.assign({}, ...[...answers.values()].map((answer) => answer.waking))
  listeners.forEach((listener) => listener())
}

/**
 * Asks one server now and shares its answer with every screen. Undefined when the read failed: a
 * busy host starting another bot's run or a dropped connection says nothing about what runs, so the
 * last answer stands instead of clearing every mark of that server.
 */
export function readLiveRuns(
  server: Server,
  { join = true }: { join?: boolean } = {},
): Promise<LiveRuns | undefined> {
  const key = connectionKey(server)
  // One read per server at a time for everything that asks in the same breath: the shared poll, a
  // chat opening and a stream's event land together far more often than apart. A caller about to
  // act on "the host lists no run" asks afresh (`join: false`): a read that left before the run
  // began would answer for a moment that has passed.
  const out = join ? asking.get(key) : undefined
  if (out) return out
  // The order this read was asked in, per server: an answer from an older read must neither
  // overwrite a newer one nor be read as the runs that ended between the two. A caller about to act
  // on "no run" asks afresh (`join: false`) while the shared poll's read is still out, and the two
  // can land in either order — the fresh one asked later holds the newer answer.
  const order = (asked.get(key) ?? 0) + 1
  asked.set(key, order)
  const read = getLiveRuns(server, AbortSignal.timeout(READ_TIMEOUT_MS))
    .catch(quietly("Reading runs/live"))
    .then((next) => {
      if (next && order >= (applied.get(key) ?? 0)) {
        applied.set(key, order)
        const before = answers.get(key)
        answers.set(key, next)
        notify()
        const ended = before ? endedSessions(before, next) : []
        // Fire and forget: nothing about the answer waits on a chat's clock moving.
        if (ended.length) void noteEndedRuns(key, ended).catch(quietly("Noting ended runs"))
      }
      return next ?? undefined
    })
    .finally(() => {
      if (asking.get(key) === read) asking.delete(key)
    })
  asking.set(key, read)
  return read
}

/** The reads still out, by server, so a second ask joins the first. */
const asking = new Map<string, Promise<LiveRuns | undefined>>()
/** The order each server's reads were asked in, and the newest one applied, so a late answer from
 * an older read is left where it belongs: out of the shared answer, and out of the ended-run diff. */
const asked = new Map<string, number>()
const applied = new Map<string, number>()

/**
 * The run the host has in flight for a session, asked through the shared read so every screen gets
 * the answer: its id, null when the host says there is none, and undefined when it couldn't say.
 */
export async function readLiveRunOf(
  server: Server,
  sessionId: string,
  options?: { join?: boolean },
): Promise<string | null | undefined> {
  const answer = await readLiveRuns(server, options)
  return answer ? (answer.runIds[sessionId] ?? null) : undefined
}

/**
 * Moves the clock of every conversation of the runs that ended on this server while the app was
 * open, which is the arrival a bot row's unread dot measures (`updatedAt` past this device's read
 * mark, ADR 0110): a chat's own reply is flushed by the thread that is open, and the plugin pushes
 * nothing to a device holding the events stream, so nothing else would say the run is over.
 *
 * The clock is written straight to the row, never through `updateConversation`: that stamps
 * `changedAt`, which would push this record into the chat-list merge at a clock this device just
 * invented — and a merge is newer-wins, so a record whose fields are stale would beat the host's
 * newer one and carry its loss to every device (a rename, a pin, a resolve, a deletion). This
 * device's own mark is the only reader of the moved clock, so the record stays here: a same-clock
 * merge does not pull it back, and a strictly newer one carries a real clock over it.
 */
async function noteEndedRuns(key: string, ended: string[]) {
  const bots = new Set(
    (await db.profiles.toArray())
      .filter((profile) => connectionKey(profile) === key)
      .map((profile) => profile.id),
  )
  const chats = await db.conversations.where("hermesSessionId").anyOf(ended).toArray()
  // Another bot's chat, a closed one and the chat on screen are all left alone: an open thread's
  // own activity is what marks it. One transaction for the whole batch, so a host restart's dozens
  // of ended runs are one write rather than one each.
  await db.transaction("rw", db.conversations, async () => {
    for (const chat of chats) {
      if (!bots.has(chat.profileId) || closedSession(chat) || chatOnScreen(chat.id)) continue
      await db.conversations.update(chat.id, { updatedAt: Date.now() })
    }
  })
}

async function poll(only: Server[] = servers) {
  if (document.visibilityState !== "visible") return
  await Promise.all(only.map((server) => readLiveRuns(server)))
  if (only.length) markResume("runs-live-end", { requests: only.length })
  notify()
}

function pollDue() {
  rounds += 1
  const all = rounds % (SAFETY_MS / RUNS_MS) === 0
  void poll(all ? servers : servers.filter((server) => !isLive(server)))
}

function pollAll() {
  void poll()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    void poll()
    timer = window.setInterval(pollDue, RUNS_MS)
    document.addEventListener("visibilitychange", pollAll)
    stopListening = onChanges("runs", (key) => {
      void poll(servers.filter((server) => connectionKey(server) === key))
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    window.clearInterval(timer)
    document.removeEventListener("visibilitychange", pollAll)
    stopListening?.()
  }
}

let stopListening: (() => void) | undefined

/** Why each session, by Hermes session id, waits on the user, across every keyed bot's server. */
export function useWaiting(): Found {
  const waiting = useSyncExternalStore(subscribe, () => found)
  // Keyless bots have no session ids, so nothing of theirs can be matched. A bot whose plugin hasn't
  // answered would only fail every poll; sync's own probe finds the plugin once it's there.
  const keyed = useLiveQuery(async () => {
    const profiles = await db.profiles.toArray()
    const unique = new Map(
      profiles.filter((p) => p.apiKey && !p.disabled).map((p) => [connectionKey(p), p]),
    )
    return [...unique.values()].map(({ baseUrl, apiKey }) => ({ baseUrl, apiKey }))
  }, [])
  useEffect(() => {
    // Sync rewrites profile rows often; only a change to the servers asks them again.
    const same = (a: Server[], b: Server[]) =>
      a.length === b.length && a.every((s, i) => connectionKey(s) === connectionKey(b[i]))
    if (keyed === undefined || same(keyed, servers)) return
    servers = keyed
    answers = new Map([...answers].filter(([key]) => servers.some((s) => connectionKey(s) === key)))
    void poll()
  }, [keyed])
  return waiting
}

/** Sessions with a run in flight on the bot's server, by Hermes session id. Needs the plugin. */
export function useLiveRuns(profile: Server | undefined) {
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  const key = baseUrl && apiKey ? connectionKey({ baseUrl, apiKey }) : undefined
  // Asked once as the screen opens; the shared poll keeps it current after that.
  useEffect(() => {
    if (baseUrl && apiKey) void readLiveRuns({ baseUrl, apiKey })
  }, [baseUrl, apiKey])
  return useSyncExternalStore(subscribe, () => (key && answers.get(key)?.sessions) || NO_RUNS)
}

/** Sessions with a run in flight on any bot's server, by Hermes session id. Needs the plugin. */
export function useAllLiveRuns() {
  useWaiting()
  return useSyncExternalStore(subscribe, () => running)
}

/**
 * How many subagents each session still runs, by Hermes session id, from the same shared poll: a
 * session whose turn has ended reads as working while one of them is, on every screen that draws a
 * state. Needs a plugin that reports them; one that doesn't leaves every session as it was.
 */
export function useLiveSubagents(): Record<string, number> {
  useWaiting()
  return useSyncExternalStore(subscribe, () => subagents)
}

/**
 * How many finished subagents each session's wake turn is still owed, by Hermes session id, from the
 * same shared poll: between a subagent ending and its wake turn starting there is no live run and no
 * running subagent, and a session that reads at rest there reads as stalled exactly when the bot is
 * about to resume. A plugin that predates the field leaves every session as it was. Needs the plugin.
 */
export function useLiveWaking(): Record<string, number> {
  useWaiting()
  return useSyncExternalStore(subscribe, () => waking)
}

/** A session's run in flight on its server, from the shared poll's last answer. */
export function knownLiveRun(server: Server, sessionId: string) {
  const answer = answers.get(connectionKey(server))
  const runId = answer?.runIds[sessionId]
  return runId ? { runId, status: answer?.sessions[sessionId] } : undefined
}

/**
 * What the host says of this session's run: its status while one is in flight, and nothing once it
 * has ended — the half of `runFinished` that is the host's to answer. Read from the shared poll like
 * the project screen's, so an open chat asks nothing of its own. Needs the plugin.
 */
export function useLiveRun(
  profile: Server | undefined,
  sessionId: string | undefined,
): LiveRunStatus | undefined {
  useWaiting()
  const key = profile?.baseUrl && profile.apiKey ? connectionKey(profile as Server) : undefined
  return useSyncExternalStore(
    subscribe,
    () => (key && sessionId && answers.get(key)?.sessions[sessionId]) || undefined,
  )
}

/**
 * Whether the host still has subagents at work for this session, or a wake turn it owes: a boolean
 * read inside the snapshot, so a screen that only needs the fact re-renders when it flips and not
 * on every poll of everyone's sessions.
 */
export function useHostBusy(sessionId: string | undefined): boolean {
  useWaiting()
  return useSyncExternalStore(subscribe, () =>
    Boolean(sessionId && (subagents[sessionId] || waking[sessionId])),
  )
}

/**
 * The id of the run the host has in flight for this session, from the same shared poll. Unlike its
 * status it changes when one run hands over to the next (a wake turn starting as the last one ends),
 * which is what a screen that follows runs has to notice.
 */
export function useLiveRunId(
  profile: Server | undefined,
  sessionId: string | undefined,
): string | undefined {
  useWaiting()
  const key = profile?.baseUrl && profile.apiKey ? connectionKey(profile as Server) : undefined
  return useSyncExternalStore(
    subscribe,
    () => (key && sessionId && answers.get(key)?.runIds[sessionId]) || undefined,
  )
}

/** Sessions of every kind, across every bot, waiting on the user, newest first. Needs the plugin. */
export function useWaitingSessions(): WaitingSession[] {
  const waiting = useWaiting()
  // The conversations of the sessions the poll says wait, read by Hermes session id: a project's,
  // a plain chat's and a canvas's alike. A session with no conversation here has no row to open,
  // and is correctly absent.
  const ids = Object.keys(waiting)
  const sessions = useLiveQuery(
    () =>
      ids.length
        ? db.conversations
            .where("hermesSessionId")
            .anyOf(ids)
            .filter((c) => !c.resolvedAt && !c.discardedAt)
            .toArray()
        : [],
    // The waiting ids as one string, so a different session waiting re-reads the query.
    [JSON.stringify(ids)],
  )
  // The query can lag a poll, so a session no longer waiting is skipped.
  return [...(sessions ?? [])]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap(({ id, title, hermesSessionId }) => {
      if (!waiting[hermesSessionId]) return []
      const { project, ...reason } = waiting[hermesSessionId]
      return [{ sessionId: id, title, reason, project }]
    })
}
