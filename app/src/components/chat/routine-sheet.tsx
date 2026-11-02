/**
 * The read-only sheet a routine's chip opens (ADR 0081): the run's own transcript, drawn as the chat
 * draws a reply, with its interfaces and no stats. There is no composer, no steer and no approval in
 * it, because the run's session is a `cron` one and Hermes refuses a turn on it.
 *
 * It lives apart from the chip so the chat's message component never imports the module that imports
 * it: the sheet draws `MessageItem`s, and `MessageItem` draws the chip.
 */
import { useEffect, useRef, useState } from "react"

import { MessageItem } from "@/components/chat/message-item"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { agentTranscript } from "@/lib/agents"
import { serverConfig } from "@/lib/connection"
import type { Message } from "@/lib/db"
import type { PluginServer } from "@/lib/features"
import { toMessages } from "@/lib/history"
import { useDraws } from "@/lib/openui-draws"
import type { RoutineRun } from "@/lib/routine-runs"

/** No rows at all, as the same value on every render. */
const NO_ROWS: Message[] = []

/** What a run the host no longer holds reads as: a sentence, never a loader and never an error. */
export const RUN_GONE = "This run is no longer on the host."

/** What a run's transcript that couldn't be read at all reads as — the host is away, not emptied. */
export const RUN_UNREAD = "Couldn't load this run."

/** The sheet a routine's chip opens: the run's transcript, and nothing a reader could send. */
export function RoutineRunSheet({
  run,
  server,
  open,
  onOpenChange,
}: {
  run: RoutineRun | undefined
  server: PluginServer
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="lg" dataSlot="routine-run">
        {open && run && <RunView run={run} server={server} />}
      </PopupContent>
    </Popup>
  )
}

function RunView({ run, server }: { run: RoutineRun; server: PluginServer }) {
  const { messages, failed } = useRunTranscript(server, run.runSession)
  const draws = useDraws(messages ?? NO_ROWS, server)
  const end = useRef<HTMLDivElement>(null)
  const loaded = messages !== undefined
  useEffect(() => {
    if (loaded) end.current?.scrollIntoView({ block: "end" })
  }, [loaded])
  const empty = loaded && messages.length === 0
  return (
    <>
      <PopupHeader className="gap-1 pb-3">
        <PopupTitle>{run.title ?? "Routine"}</PopupTitle>
        {/* The thread's line says how long the run took; when it ran and what it ran on are here. */}
        <p className="text-sm text-muted-foreground">
          {[ranOn(run.at), run.model].filter(Boolean).join(" · ")}
        </p>
      </PopupHeader>
      <div className="flex flex-col gap-4 px-4 pb-6">
        {messages?.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            showStats={false}
            blocks={draws.get(message.id)}
          />
        ))}
        {(empty || failed) && (
          <p data-slot="routine-run-note" className="px-2 text-sm text-muted-foreground">
            {empty ? RUN_GONE : RUN_UNREAD}
          </p>
        )}
        <div ref={end} />
      </div>
    </>
  )
}

/** The day a run was stamped with, as a reader says it: "Nov 3rd, 2026". */
function ranOn(at: number) {
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

/** Runs that are over don't change, so a transcript is read once per connection and run. */
const finished = new Map<string, Message[]>()

/** How many transcripts are kept: a reader who opens a run, then another, doesn't hold every row. */
const KEEP_RUNS = 8

/**
 * A run's transcript, as the subagent sheet reads an agent's: the newest rows of the session the run
 * wrote, folded the way a chat's reply is. A session the host no longer holds (its 404) is an empty
 * read, which is what the sheet says plainly.
 */
function useRunTranscript(server: PluginServer, runSession: string | null) {
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
        if (finished.size >= KEEP_RUNS) finished.delete(finished.keys().next().value as string)
        finished.set(cacheKey, next)
        setMessages(next)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [baseUrl, apiKey, id, cacheKey, kept])
  return { messages: kept ?? messages, failed: !kept && failed }
}
