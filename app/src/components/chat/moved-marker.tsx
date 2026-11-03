import { MessagesSquareIcon, Undo2Icon } from "lucide-react"

import { SystemLine, SystemLink } from "@/components/chat/system-line"
import { UserBubble } from "@/components/chat/user-bubble"
import { COLUMN } from "@/lib/layout"
import { stayHere } from "@/lib/nav"
import { cn } from "@/lib/utils"

import type { Move } from "@/lib/hermes"

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
  return (
    <div data-slot="moved-marker" data-move={move.id} className={cn("flex flex-col gap-1", COLUMN)}>
      <UserBubble className="self-end">{move.text}</UserBubble>
      {/* The bot's reply, a line like a tool group's: only the thread's name is a link. */}
      <SystemLine>
        Moved to
        {title ? (
          <>
            {" “"}
            <SystemLink
              icon={MessagesSquareIcon}
              to={`/c/${move.threadId}`}
              state={{ bot: profileId }}
              onClick={stayHere(current)}
            >
              {title}
            </SystemLink>
            {"”"}
          </>
        ) : (
          <>
            {" "}
            <SystemLink
              icon={MessagesSquareIcon}
              to={`/c/${move.threadId}`}
              state={{ bot: profileId }}
              onClick={stayHere(current)}
            >
              a thread
            </SystemLink>
          </>
        )}
        {move.undoable && onUndo && (
          // On its own line as a block, so nothing sits between it and the line above. The padding
          // and matching negative margin keep the target 44px tall without adding any space.
          <button
            type="button"
            onClick={() => onUndo(move)}
            aria-label="Undo"
            className="relative z-10 -my-3 flex w-fit items-center gap-1 py-3 font-medium text-info underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            <Undo2Icon className="size-3.5" />
            Undo
          </button>
        )}
      </SystemLine>
    </div>
  )
}
