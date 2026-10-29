import type { ReactNode } from "react"

import { Spinner } from "@/components/ui/spinner"
import { CATCHING_ACTIVITY, THINKING_ACTIVITY, WRITING_ACTIVITY } from "@/lib/format"
import type { BusyKind } from "@/lib/busy-words"
import { REPLY_INSET } from "@/lib/layout"
import { useBusyWord } from "@/lib/use-busy-word"
import { cn } from "@/lib/utils"

/** The activity lines that are dressed in a rotating word; any other line stands as written. */
const KIND_OF: Record<string, BusyKind | undefined> = {
  [THINKING_ACTIVITY]: "thinking",
  [WRITING_ACTIVITY]: "writing",
  [CATCHING_ACTIVITY]: "catching",
}

/**
 * What a reply is doing, in one line under it: the chat's own activity line, and the line a
 * question the agent asked waits on while this screen holds its form in the composer slot. A turn
 * that wants the reader, not the host, says so without a loader: nothing is working.
 */
export function StatusLine({
  text,
  seed = "",
  waiting,
  children,
}: {
  text?: string
  /** What the rotating word is drawn from, so a reply keeps its own while it streams. */
  seed?: string
  /** The turn wants the reader, not the host: its words stand and no loader turns beside them. */
  waiting?: boolean
  children?: ReactNode
}) {
  const working = Boolean(text) && !waiting
  const kind = working && text ? KIND_OF[text] : undefined
  const word = useBusyWord(kind, seed) ?? text
  return (
    <div
      className={cn(
        REPLY_INSET,
        "flex items-center gap-2 text-sm",
        working ? "text-primary" : "text-muted-foreground",
      )}
      aria-live="polite"
      data-slot="status-line"
    >
      {working && <Spinner aria-hidden />}
      {word && (
        <span className="min-w-0 truncate" data-slot="status-words">
          {word}
        </span>
      )}
      {children}
    </div>
  )
}
