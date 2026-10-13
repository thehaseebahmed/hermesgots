import { useEffect, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { db } from "@/lib/db"
import { getLiveRuns, type LiveRunStatus, type LiveRuns, type WaitingReason } from "@/lib/hermes"
import { connectionKey, isLive, onChanges, SAFETY_MS } from "@/lib/live"

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
  if (reason.kind === "theseus") return THESEUS_WAITS[reason.stage]
  return "Plan ready for review"
}

const THESEUS_WAITS = {
  plan: "Plan ready to confirm",
  checkpoints: "Checkpoints ready to approve",
  approval: "A checkpoint needs your approval",
  closing: "Ready to close the run",
} as const

const POLL_MS = 10_000
const TIMEOUT_MS = 15_000

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
  listeners.forEach((listener) => listener())
}

/**
 * Asks one server now and shares its answer with every screen. Undefined when the read failed: a
 * busy host starting another bot's run or a dropped connection says nothing about what runs, so the
 * last answer stands instead of clearing every mark of that server.
 */
export async function readLiveRuns(server: Server): Promise<LiveRuns | undefined> {
  const next = await getLiveRuns(server, AbortSignal.timeout(TIMEOUT_MS)).catch(() => undefined)
  if (next) {
    answers.set(connectionKey(server), next)
    notify()
  }
  return next
}

async function poll(only: Server[] = servers) {
  if (document.visibilityState !== "visible") return
  await Promise.all(only.map(readLiveRuns))
  notify()
}

function pollDue() {
  rounds += 1
  const all = rounds % (SAFETY_MS / POLL_MS) === 0
  void poll(all ? servers : servers.filter((server) => !isLive(server)))
}

function pollAll() {
  void poll()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    void poll()
    timer = window.setInterval(pollDue, POLL_MS)
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
