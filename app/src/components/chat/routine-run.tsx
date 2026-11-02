/**
 * The card a routine's message wears (ADR 0081): which routine spoke, what it ran on, and how long it
 * took — the shape the thread's own subagent card has, so a receipt of work done reads the same
 * whether an agent or a routine did it. The sheet it opens lives in `routine-sheet.tsx`, which draws
 * `MessageItem`s — the module this one is drawn by — so the two never import each other.
 */
import { useEffect, useState } from "react"
import { CheckIcon, TimerIcon } from "lucide-react"

import { RoutineRunSheet } from "@/components/chat/routine-sheet"
import { FLAT_CARD } from "@/components/chat/session-cards"
import type { Message } from "@/lib/db"
import { usePluginFeatureOn } from "@/lib/features"
import { shortModel } from "@/lib/model-info"
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
 * Whether the host named enough of a delivery for a chip to open its run: the routine it came from
 * and the session the run wrote. The routine's name is what the chip says, and a routine with none
 * is still a run the reader can open.
 */
function namesRun(run: RoutineRun | undefined): run is RoutineRun {
  return Boolean(run && run.jobId && run.runSession)
}

/** The name a chip gives a routine the host didn't name. */
const UNNAMED = "Routine"

/**
 * What the card says about the run under its name: how long it took, and what it ran on. The timer is
 * the Routines screen's own mark, so the card is recognisably a routine's; the model is the long part
 * and drops out of the line only when there is no room for it.
 */
function RunLine({ run }: { run: RoutineRun }) {
  const length = run.seconds === null ? undefined : `Ran for ${ranFor(run.seconds)}`
  const model = run.model ? shortModel(run.model) : undefined
  const line = [length, model].filter(Boolean).join(" · ")
  // A delivery the host couldn't time names nothing rather than an empty "Ran": the card still says
  // which routine spoke, and the sheet it opens is where the run's own record is.
  if (!line) return null
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <CheckIcon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{line}</span>
    </span>
  )
}

/**
 * The card that stands on a routine's message: the plate a subagent's card has, the Routines screen's
 * timer beside the name, and the run's own numbers under it. The whole plate opens the run — there is
 * no chevron and nothing else to press, exactly like the thread card it sits beside.
 */
export function RoutineChip({ run, onOpen }: { run: RoutineRun; onOpen: () => void }) {
  return (
    <div data-slot="routine-card" className={cn(FLAT_CARD, "flex items-center gap-3 px-4 py-3")}>
      <button
        type="button"
        aria-label={`Routine: ${run.title ?? UNNAMED}`}
        onClick={onOpen}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl text-left outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <TimerIcon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{run.title ?? UNNAMED}</span>
          </span>
          <RunLine run={run} />
        </span>
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
