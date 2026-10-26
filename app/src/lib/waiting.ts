import { useEffect, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { READ_TIMEOUT_MS, RUNS_MS, SAFETY_MS } from "@/lib/freshness"
import { quietly } from "@/lib/report"
import { db } from "@/lib/db"
import { getLiveRuns, type LiveRunStatus, type LiveRuns, type WaitingReason } from "@/lib/hermes"
import { connectionKey, isLive, onChanges } from "@/lib/live"
import { markResume } from "@/lib/resume-trace"

export type { WaitingReason }

/** A project session, in any project, that waits for the user. */
export interface WaitingSession {
  sessionId: string
  title: string
  reason: WaitingReason
  project?: string
}

export function reasonText(reason: WaitingReason) {
  if (reason.kind === "question")
    return reason.count > 1 ? `${reason.count} questions to answer` : "Awaiting your answer"
  if (reason.kind === "approval") {
    const command = reason.command?.split("\n")[0].trim()
    return command ? `Approve ${command}` : "Needs approval to run a command"
  }
  if (reason.kind === "stalled") return reason.reason
  if (reason.kind === "plan") return "Plan ready for review"
  // A kind this build doesn't know yet still means the session wants the user, not a plan.
  return "Needs you"
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
export async function readLiveRuns(server: Server): Promise<LiveRuns | undefined> {
  const next = await getLiveRuns(server, AbortSignal.timeout(READ_TIMEOUT_MS)).catch(
    quietly("Reading runs/live"),
  )
  if (next) {
    answers.set(connectionKey(server), next)
    notify()
  }
  return next
}

async function poll(only: Server[] = servers) {
  if (document.visibilityState !== "visible") return
  await Promise.all(only.map(readLiveRuns))
  // One read per server went out in this pass; named so a resume can show them.
  markResume("runs-live-end", only.length)
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

/** Project sessions, across every bot, waiting on the user, newest first. Needs the plugin. */
export function useWaitingSessions(): WaitingSession[] {
  const waiting = useWaiting()
  const any = Object.keys(waiting).length > 0
  // Every open project session, matched to what waits below, so the query needn't follow the ids.
  const sessions = useLiveQuery(
    () =>
      any
        ? db.conversations
            .where("projectId")
            .above("")
            .filter((c) => !c.resolvedAt && !c.discardedAt)
            .toArray()
        : [],
    [any],
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
