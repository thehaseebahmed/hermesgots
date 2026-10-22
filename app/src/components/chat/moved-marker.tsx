import { Link } from "react-router"
import { CornerUpRightIcon, Undo2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Move } from "@/lib/hermes"

/** Where triage sent a message from Main: its words and the way to the thread that has them now. */
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
    <div className="mx-auto flex max-w-full items-center gap-2">
      <Link
        to={`/c/${move.threadId}`}
        state={{ bot: profileId }}
        aria-label={`Moved${where}: ${move.text}`}
        className="flex min-h-11 min-w-0 items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CornerUpRightIcon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{move.text}</span>
        <span className="shrink-0 font-medium text-info">Moved{where}</span>
      </Link>
      {move.undoable && onUndo && (
        <Button variant="ghost" className="min-h-11 shrink-0" onClick={() => onUndo(move)}>
          <Undo2Icon />
          Undo
        </Button>
      )}
    </div>
  )
}
