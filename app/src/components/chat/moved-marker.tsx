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
  const where = title ? ` to ${title}` : ""
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Bubble variant="default" align="end">
        <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
          {move.text}
        </BubbleContent>
      </Bubble>
      <div className="flex max-w-full items-center gap-1 text-sm text-muted-foreground">
        <Link
          to={`/c/${move.threadId}`}
          state={{ bot: profileId }}
          aria-label={`Moved${where}`}
          className="flex min-h-11 min-w-0 items-center gap-1 rounded-full px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate font-medium text-info">Moved{where}</span>
          <ChevronRightIcon className="size-4 shrink-0" />
        </Link>
        {move.undoable && onUndo && (
          <button
            type="button"
            onClick={() => onUndo(move)}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-full px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Undo2Icon className="size-4" />
            Undo
          </button>
        )}
      </div>
    </div>
  )
}
