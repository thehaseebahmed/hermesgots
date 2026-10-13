import { useEffect, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { db } from "@/lib/db"
import { listLiveRuns, listWaiting, type LiveRunStatus, type WaitingReason } from "@/lib/hermes"
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

/** Why each session, by Hermes session id, waits on the user, across every keyed bot's server. */
type Found = Record<string, WaitingReason & { project?: string }>
/** Which sessions have a run in flight, by Hermes session id. */
type Runs = Record<string, LiveRunStatus>
type Server = { baseUrl: string; apiKey: string }

/**
 * What every bot's server reports: why each session waits on the user, and which have a run in
 * flight, both by Hermes session id. One poll for the whole app, shared by every screen that reads
 * them, and only while one is. A server that streams its changes is asked when it says a run
 * changed, and now and then anyway; the rest are asked every few seconds.
 */
let answers = new Map<string, Found>()
let runs = new Map<string, Runs>()
let found: Found = {}
let live: Runs = {}
let servers: Server[] = []
const listeners = new Set<() => void>()
let timer: number | undefined
let rounds = 0

async function poll(only: Server[] = servers) {
  if (document.visibilityState !== "visible") return
  await Promise.all(
    only.map(async (server) => {
      // A failed read (a busy host starting another bot's run, a dropped connection) says nothing
      // about what waits or what runs, so the last answer stands instead of clearing every mark.
      const [waiting, running] = await Promise.all([
        listWaiting(server, AbortSignal.timeout(TIMEOUT_MS)).catch(() => undefined),
        listLiveRuns(server, AbortSignal.timeout(TIMEOUT_MS)).catch(() => undefined),
      ])
      if (waiting) answers.set(connectionKey(server), waiting)
      if (running) runs.set(connectionKey(server), running)
    }),
  )
  found = Object.assign({}, ...servers.map((server) => answers.get(connectionKey(server)) ?? {}))
  live = Object.assign({}, ...servers.map((server) => runs.get(connectionKey(server)) ?? {}))
  listeners.forEach((listener) => listener())
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

/**
 * Why each session, by Hermes session id, waits on the user, across every keyed bot's server.
 */
export function useWaiting(): Found {
  const waiting = useSyncExternalStore(subscribe, () => found)
  // Keyless bots have no session ids, so nothing of theirs can be matched. A bot whose plugin hasn't
  // answered would only fail every poll; sync's own probe finds the plugin once it's there.
  const keyed = useLiveQuery(async () => {
    const profiles = await db.profiles.toArray()
    const unique = new Map(
      profiles
        .filter((p) => p.apiKey && !p.disabled)
        .map((p) => [`${p.baseUrl.trim().replace(/\/+$/, "")} ${p.apiKey}`, p]),
    )
    return JSON.stringify([...unique.values()].map(({ baseUrl, apiKey }) => ({ baseUrl, apiKey })))
  }, [])
  useEffect(() => {
    if (keyed === undefined) return
    servers = JSON.parse(keyed)
    answers = new Map([...answers].filter(([key]) => servers.some((s) => connectionKey(s) === key)))
    runs = new Map([...runs].filter(([key]) => servers.some((s) => connectionKey(s) === key)))
    void poll()
  }, [keyed])
  return waiting
}

/**
 * Which sessions have a run in flight, by Hermes session id, across every keyed bot's server. The
 * same poll the waiting reasons come from, so a screen and the sidebar never disagree.
 */
export function useLiveRuns(): Runs {
  return useSyncExternalStore(subscribe, () => live)
}

/** Project sessions, across every bot, waiting on the user, newest first. Needs the plugin. */
export function useWaitingSessions(): WaitingSession[] {
  const waiting = useWaiting()
  const ids = Object.keys(waiting)
  const sessions = useLiveQuery(
    () =>
      ids.length
        ? db.conversations
            .where("projectId")
            .above("")
            .filter((c) => ids.includes(c.hermesSessionId) && !c.resolvedAt && !c.discardedAt)
            .toArray()
        : [],
    [ids.join()],
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
