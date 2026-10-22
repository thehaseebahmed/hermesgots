import { Link } from "react-router"
import { MessagesSquareIcon, Undo2Icon } from "lucide-react"

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
      {/* The bot's reply, a line like a tool group's: only the thread's name is a link, and Undo is under it. */}
      <div className="flex flex-col items-start text-sm leading-5 text-muted-foreground">
        <p className="flex min-h-11 max-w-full items-center">
          <span className="shrink-0">Moved to&nbsp;{title ? "\u201c" : ""}</span>
          <Link
            to={`/c/${move.threadId}`}
            state={{ bot: profileId }}
            className="flex min-w-0 items-center gap-1 font-medium text-info underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            <MessagesSquareIcon className="size-3.5 shrink-0" />
            <span className="truncate">{title ?? "a thread"}</span>
          </Link>
          {title && <span className="shrink-0">{"\u201d"}</span>}
        </p>
        {move.undoable && onUndo && (
          <button
            type="button"
            onClick={() => onUndo(move)}
            className="-mt-2.5 flex min-h-11 items-center gap-1 font-medium text-info underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            <Undo2Icon className="size-3.5" />
            Undo
          </button>
        )}
      </div>
    </div>
  )
}
