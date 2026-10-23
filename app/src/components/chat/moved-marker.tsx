import { Link } from "react-router"
import { MessagesSquareIcon, Undo2Icon } from "lucide-react"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import type { Move } from "@/lib/hermes"
import { stayHere } from "@/lib/utils"

/**
 * A message triage sent out of Main, drawn where it was sent: the user's own bubble with a line
 * under it naming the thread that has it now, and Undo while that thread hasn't replied.
 */
export function MovedMarker({
  move,
  title,
  profileId,
  current = false,
  onUndo,
}: {
  move: Move
  title?: string
  profileId: string
  /** Whether the address already is the thread that has the message, so its link goes nowhere. */
  current?: boolean
  onUndo?: (move: Move) => void
}) {
  const follow = stayHere(current)
  return (
    <div className="flex flex-col gap-1">
      <Bubble variant="default" align="end" className="self-end">
        <BubbleContent className="px-4 py-2.5 text-[15px] whitespace-pre-wrap">
          {move.text}
        </BubbleContent>
      </Bubble>
      {/* The bot's reply, a line like a tool group's: only the thread's name is a link. */}
      <p className="min-h-11 py-3 text-sm leading-5 text-muted-foreground">
        Moved to
        {title ? (
          <>
            {" “"}
            <Link
              to={`/c/${move.threadId}`}
              state={{ bot: profileId }}
              onClick={follow}
              className="font-medium text-info underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              <MessagesSquareIcon className="mr-1 inline size-3.5 align-[-2px]" />
              {title}
            </Link>
            {"”"}
          </>
        ) : (
          <>
            {" "}
            <Link
              to={`/c/${move.threadId}`}
              state={{ bot: profileId }}
              onClick={follow}
              className="font-medium text-info underline-offset-2 hover:underline"
            >
              a thread
            </Link>
          </>
        )}
        {move.undoable && onUndo && (
          // On its own line as a block, so nothing sits between it and the line above. The padding
          // and matching negative margin keep the target 44px tall without adding any space.
          <button
            type="button"
            onClick={() => onUndo(move)}
            aria-label="Undo"
            className="-my-3 flex w-fit items-center gap-1 py-3 font-medium text-info underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            <Undo2Icon className="size-3.5" />
            Undo
          </button>
        )}
      </p>
    </div>
  )
}
