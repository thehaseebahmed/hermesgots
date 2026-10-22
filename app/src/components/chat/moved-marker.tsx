import { Link } from "react-router"
import { ChevronRightIcon, Undo2Icon } from "lucide-react"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import type { Move } from "@/lib/hermes"

/**
 * A message triage sent out of Main, drawn where it was sent: the user's own bubble with a line
 * under it naming the thread that has it now, and Undo while that thread hasn't replied.
 */
export function MovedMarker({
  move,
  title,
  profileId,
  onUndo,
}: {
  move: Move
  title?: string
  profileId: string
  onUndo?: (move: Move) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <Bubble variant="default" align="end" className="self-end">
        <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
          {move.text}
        </BubbleContent>
      </Bubble>
      {/* The bot's reply, a line like a tool group's: the title in full, Undo right under it. */}
      <div className="flex flex-col items-start text-sm text-muted-foreground">
        <Link
          to={`/c/${move.threadId}`}
          state={{ bot: profileId }}
          aria-label={`Moved${title ? ` to ${title}` : ""}`}
          className="flex min-h-11 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="min-w-0">Moved to{title ? ` \u201c${title}\u201d` : ""}</span>
          <ChevronRightIcon className="size-4 shrink-0" />
        </Link>
        {move.undoable && onUndo && (
          <button
            type="button"
            onClick={() => onUndo(move)}
            className="-mt-2 flex min-h-11 items-center gap-1 font-medium text-info outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Undo2Icon className="size-4" />
            Undo
          </button>
        )}
      </div>
    </div>
  )
}
