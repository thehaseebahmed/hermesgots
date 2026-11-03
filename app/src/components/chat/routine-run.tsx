/**
 * The line a routine's message wears (ADR 0081): which run wrote the words below it, what it ran on,
 * and how long it took. It is the app's own way of saying something happened without pretending it is
 * a message — the tone of a "Moved to …" line — placed where Slack puts a message's context, above
 * the body it belongs to, so the words read as the message and this reads as where they came from.
 * The sheet it opens lives in `routine-sheet.tsx`, which draws `MessageItem`s — the module this one is
 * drawn by — so the two never import each other.
 */
import { useEffect, useState } from "react"
import { TimerIcon } from "lucide-react"

import { RoutineRunSheet } from "@/components/chat/routine-sheet"
import { SystemLine, SystemLink } from "@/components/chat/system-line"
import type { Message } from "@/lib/db"
import { usePluginFeatureOn } from "@/lib/features"
import { COLUMN } from "@/lib/layout"
import { ranFor } from "@/lib/routine-message"
import {
  askRoutineRuns,
  ROUTINE_MESSAGE_FEATURE,
  useRoutineChat,
  useRoutineRuns,
  type RoutineRun,
} from "@/lib/routine-runs"
import { cn } from "@/lib/utils"

/**
 * Whether the host named enough of a delivery for a line to open its run: the routine it came from
 * and the session the run wrote. The routine's name is what the line says, and a routine with none
 * is still a run the reader can open.
 */
function namesRun(run: RoutineRun | undefined): run is RoutineRun {
  return Boolean(run && run.jobId && run.runSession)
}

/** The name a line gives a routine the host didn't name. */
const UNNAMED = "Routine"

/**
 * What the line says after the routine's name: how long it ran, and nothing else. The model is the
 * sheet's to say — a receipt in the thread answers "what is this and how long did it take", and the
 * run's own record is one tap away. A run the host couldn't time names the routine alone.
 */
function said(run: RoutineRun) {
  return run.seconds === null ? "" : ` in ${ranFor(run.seconds)}`
}

/**
 * The line that stands above a routine's message, in the app's own sentence shape: "Ran “Morning
 * watch” in 12s" — the same line the Moved marker draws, with the run's name where the thread's
 * name goes, so a reader meets one pattern wherever the app talks about the thread instead of in it.
 */
export function RoutineChip({ run, onOpen }: { run: RoutineRun; onOpen: () => void }) {
  return (
    <div data-slot="routine-receipt" className={cn(COLUMN, "mb-1")}>
      <SystemLine>
        {"Ran “"}
        <SystemLink icon={TimerIcon} onClick={onOpen} label={`Routine: ${run.title ?? UNNAMED}`}>
          {run.title ?? UNNAMED}
        </SystemLink>
        {"”"}
        {said(run)}
      </SystemLine>
    </div>
  )
}

/**
 * The line a routine's message wears, and the sheet it opens. Drawn only on a routine's message, so a
 * chat with none of them asks the host nothing; a message the answer doesn't name draws no line.
 */
export function RoutineReceipt({ message }: { message: Message }) {
  const chat = useRoutineChat(message.conversationId)
  const runs = useRoutineRuns(chat?.server, chat?.sessionId)
  // A host without the route is asked nothing at all, the read this one follows included.
  const on = usePluginFeatureOn(chat?.server, ROUTINE_MESSAGE_FEATURE)
  const row = message.hermesRowId
  const run = row === undefined ? undefined : runs.get(row)
  const [open, setOpen] = useState(false)
  // A routine's message the answer doesn't name is one the bot delivered since it was taken: the
  // thread on screen would otherwise never show a line on it.
  useEffect(() => {
    if (!on || row === undefined || runs.has(row)) return
    askRoutineRuns(chat?.server, chat?.sessionId, row)
  }, [on, row, chat, runs])
  if (!namesRun(run)) return null
  return (
    <>
      <RoutineChip run={run} onOpen={() => setOpen(true)} />
      <RoutineRunSheet
        run={run}
        server={chat?.server}
        open={open}
        onOpenChange={(next) => setOpen(next)}
      />
    </>
  )
}
