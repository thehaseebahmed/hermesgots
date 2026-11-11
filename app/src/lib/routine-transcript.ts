/**
 * A routine's run, as a screen reads it: the newest rows of the session the run wrote, folded the
 * way a chat's reply is folded — the reading the run sheet did, now that a delivery publishes a row of
 * its own rather than writing into a chat (ADR 0081).
 *
 * A run is read once per connection and session, because a run that is over doesn't change; the
 * screen is read-only by Hermes's own rule, since a `cron`-sourced session refuses a turn.
 */
import { useEffect, useState } from "react"

import { agentTranscript } from "@/lib/agents"
import { boundedStore } from "@/lib/bounded-cache"
import { serverConfig } from "@/lib/connection"
import type { Message } from "@/lib/db"
import type { PluginServer } from "@/lib/features"
import { toMessages } from "@/lib/history"

/** What a run the host no longer holds reads as: a sentence, never a loader and never an error. */
export const RUN_GONE = "This run is no longer on the host."

/** What a run's transcript that couldn't be read at all reads as — the host is away, not emptied. */
export const RUN_UNREAD = "Couldn't load this run."

/** A transcript still being read, and whether the read failed rather than answered with nothing. */
export interface RoutineTranscript {
  messages?: Message[]
  failed: boolean
  /** The read answered — with rows or with none — so a screen can say what it found. */
  loaded: boolean
}

/**
 * Runs that are over don't change, so a transcript is read once per connection and run, and what a
 * reader has moved on from falls out: a run opened, then another, doesn't hold every row.
 */
const KEEP_RUNS = 8

const finished = boundedStore<Message[]>({ limit: KEEP_RUNS })

/**
 * A run's transcript: the newest rows of the session the run wrote, folded the way a chat's reply is.
 * A session the host no longer holds (its 404) reads as an empty answer, which the screen says
 * plainly, and any other failure is told apart from it so a host being away is never read as a run
 * that has been pruned.
 */
export function useRoutineTranscript(
  server: PluginServer,
  runSession: string | null,
): RoutineTranscript {
  const { baseUrl, apiKey } = serverConfig(server)
  const id = runSession ?? ""
  const cacheKey = `${baseUrl}|${id}`
  const [messages, setMessages] = useState<Message[]>()
  const [failed, setFailed] = useState(false)
  const kept = finished.get(cacheKey)
  useEffect(() => {
    if (kept || !id || !baseUrl) return
    let cancelled = false
    agentTranscript({ baseUrl, apiKey }, id, 500)
      .then((rows) => {
        if (cancelled) return
        const next = toMessages(`run-${id}`, id, rows, { live: false })
        finished.set(cacheKey, next)
        setMessages(next)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [baseUrl, apiKey, id, cacheKey, kept])
  const transcript = kept ?? messages
  return { messages: transcript, failed: !kept && failed, loaded: transcript !== undefined }
}

/**
 * The day a run was stamped with, as a reader says it: "Nov 3rd, 2026". A row's own clock is when the
 * delivery landed, so this is when the routine spoke.
 */
export function ranOn(at: number) {
  const when = new Date(at)
  const day = when.getDate()
  const ordinal =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th"
  const month = when.toLocaleString("en-US", { month: "short" })
  return `${month} ${day}${ordinal}, ${when.getFullYear()}`
}
