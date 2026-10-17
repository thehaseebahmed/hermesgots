import { CheckIcon, PauseIcon, XIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { Todo, TodoProgress } from "@/lib/db"
import { cn } from "@/lib/utils"

function Ring({ value }: { value: number }) {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
      <g transform="rotate(-90 10 10)">
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          className="stroke-muted-foreground/30"
        />
        {value > 0 && (
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - value)}
            className="stroke-primary"
          />
        )}
      </g>
    </svg>
  )
}

/**
 * An item the agent left in progress when its turn ended: it isn't being worked on any more, so it
 * doesn't spin.
 */
const stalled = (item: Todo, live: boolean) => item.status === "in_progress" && !live

/** The agent's progress through its todo list, for the pill row above the composer; opens the list. */
export function TodosPill({
  items,
  progress,
  live,
  onClick,
}: {
  items: Todo[]
  /** The list's progress, as the plugin worked it out; an older plugin reports none. */
  progress?: TodoProgress
  live: boolean
  onClick: () => void
}) {
  // A part-filled ring reads as a spinner, so a list the agent stopped on shows it paused.
  const stopped = items.some((item) => stalled(item, live))
  const done = progress?.done ?? 0
  const total = progress?.total ?? 0
  return (
    <Button
      type="button"
      variant="secondary"
      className="h-11 shrink-0 gap-2 rounded-full px-4 tabular-nums"
      onClick={onClick}
    >
      {stopped ? (
        <PauseIcon className="size-5 text-muted-foreground" aria-label="Stopped" />
      ) : (
        progress && <Ring value={total ? done / total : 0} />
      )}
      {progress ? `${done}/${total} todos` : "todos"}
    </Button>
  )
}

function StatusIcon({ status, stopped }: { status: Todo["status"]; stopped?: boolean }) {
  if (stopped)
    return (
      <span className="flex size-7 items-center justify-center text-muted-foreground">
        <PauseIcon className="size-4" aria-label="Stopped" />
      </span>
    )
  if (status === "completed")
    return (
      <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-primary">
        <CheckIcon className="size-4" aria-label="Done" />
      </span>
    )
  if (status === "in_progress")
    return (
      <span className="flex size-7 items-center justify-center" aria-label="In progress">
        <span className="size-5 rounded-full border-2 border-muted border-t-primary motion-safe:animate-spin" />
      </span>
    )
  if (status === "cancelled")
    return (
      <span className="flex size-7 items-center justify-center text-muted-foreground">
        <XIcon className="size-4" aria-label="Cancelled" />
      </span>
    )
  return (
    <span className="flex size-7 items-center justify-center" aria-label="Pending">
      <span className="size-5 rounded-full border-2 border-muted-foreground/50" />
    </span>
  )
}

export function TodosSheet({
  open,
  onOpenChange,
  items,
  progress,
  live,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: Todo[]
  /** The list's progress, as the plugin worked it out; an older plugin reports none. */
  progress?: TodoProgress
  /** A turn is running, so an item in progress is being worked on. */
  live: boolean
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle className="tabular-nums">
            {progress ? `${progress.done}/${progress.total} todos complete` : "Todos"}
          </PopupTitle>
        </PopupHeader>
        <div className="px-6">
          <Separator />
        </div>
        <ol className="flex flex-col px-6 pt-4">
          {items.map((item, index) => {
            const finished = item.status === "completed" || item.status === "cancelled"
            const stopped = stalled(item, live)
            return (
              <li
                key={item.id}
                className="flex gap-3"
                style={{ paddingInlineStart: `${item.depth * 1.5}rem` }}
              >
                <div className="relative w-7 shrink-0">
                  <div className="flex h-11 items-center">
                    <StatusIcon status={item.status} stopped={stopped} />
                  </div>
                  {/* Runs from under this item's icon to the next one's. */}
                  {index < items.length - 1 && (
                    <div className="absolute top-10 -bottom-1 left-1/2 w-px -translate-x-1/2 bg-border" />
                  )}
                </div>
                <p
                  className={cn(
                    "min-w-0 flex-1 py-2.5 text-[15px] leading-6 break-words",
                    finished && "text-muted-foreground line-through",
                  )}
                >
                  {item.content}
                  {stopped && <span className="text-muted-foreground"> · Stopped</span>}
                </p>
              </li>
            )
          })}
        </ol>
      </PopupContent>
    </Popup>
  )
}
