/**
 * The chip a routine's message wears (ADR 0081): which routine spoke, and the run behind it. The
 * sheet the chip opens lives in `routine-sheet.tsx`, which draws `MessageItem`s — the module this one
 * is drawn by — so the two never import each other.
 */
import { useEffect, useState } from "react"
import { BotIcon, ChevronRightIcon } from "lucide-react"

import { RoutineRunSheet } from "@/components/chat/routine-sheet"
import type { Message } from "@/lib/db"
import { usePluginFeatureOn } from "@/lib/features"
import { COLUMN, REPLY_INSET } from "@/lib/layout"
import {
  askRoutineRuns,
  ROUTINE_MESSAGE_FEATURE,
  useRoutineChat,
  useRoutineRuns,
  type RoutineRun,
} from "@/lib/routine-runs"
import { cn } from "@/lib/utils"

/** Whether the host named enough of a delivery for a chip to name the routine and open its run. */
function namesRun(run: RoutineRun | undefined): run is RoutineRun {
  return Boolean(run && run.jobId && run.title && run.runSession)
}

/**
 * The chip that stands on a routine's message: which routine spoke, on the reply's own column and in
 * the app's muted tone — a receipt of the bot's own work rather than an action the reader must take.
 * It is a button so that the run is reachable, and it says what it opens.
 */
export function RoutineChip({ run, onOpen }: { run: RoutineRun; onOpen: () => void }) {
  return (
    <div className={cn(COLUMN, REPLY_INSET)}>
      <button
        type="button"
        data-slot="routine-chip"
        aria-label={`Routine: ${run.title}`}
        onClick={onOpen}
        className="flex min-h-11 w-fit max-w-full items-center gap-2 rounded-full border border-border/70 px-3 text-xs text-muted-foreground outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <BotIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{run.title}</span>
        <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
      </button>
    </div>
  )
}

/**
 * The chip a routine's message wears, and the sheet it opens. Drawn only on a routine's message, so a
 * chat with none of them asks the host nothing; a message the answer doesn't name draws no chip.
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
  // thread on screen would otherwise never show a chip on it.
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
