import { Link } from "react-router"
import { CornerUpRightIcon } from "lucide-react"

import type { Move } from "@/lib/hermes"

/** Where triage sent a message from Main: its words and the way to the thread that has them now. */
export function MovedMarker({
  move,
  title,
  profileId,
}: {
  move: Move
  title?: string
  profileId: string
}) {
  const where = title ? ` to ${title}` : ""
  return (
    <Link
      to={`/c/${move.threadId}`}
      state={{ bot: profileId }}
      aria-label={`Moved${where}: ${move.text}`}
      className="mx-auto flex min-h-11 max-w-full items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CornerUpRightIcon className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{move.text}</span>
      <span className="shrink-0 font-medium text-info">Moved{where}</span>
    </Link>
  )
}
