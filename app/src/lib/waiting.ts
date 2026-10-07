import { useEffect, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { db } from "@/lib/db"
import { listWaiting, type WaitingReason } from "@/lib/hermes"

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
  return "Plan ready for review"
}

const POLL_MS = 10_000
const TIMEOUT_MS = 15_000

type Found = Record<string, WaitingReason & { project?: string }>

/**
 * What every bot's server reports waiting, by Hermes session id. One poll for the whole app, shared
 * by every sidebar that's mounted, and only while one is.
 */
let found: Found = {}
let servers: { baseUrl: string; apiKey: string }[] = []
const listeners = new Set<() => void>()
let timer: number | undefined

async function poll() {
  if (document.visibilityState !== "visible") return
  const answers = await Promise.all(
    servers.map((server) =>
      listWaiting(server, AbortSignal.timeout(TIMEOUT_MS)).catch(() => ({}) as Found),
    ),
  )
  found = Object.assign({}, ...answers)
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    timer = window.setInterval(poll, POLL_MS)
    document.addEventListener("visibilitychange", poll)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    window.clearInterval(timer)
    document.removeEventListener("visibilitychange", poll)
  }
}

/** Why each session, by Hermes session id, waits on the user, across every keyed bot's server. */
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
    void poll()
  }, [keyed])
  return waiting
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
