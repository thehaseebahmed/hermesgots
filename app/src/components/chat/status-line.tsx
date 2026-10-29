import type { ReactNode } from "react"

import { Spinner } from "@/components/ui/spinner"
import { REPLY_INSET } from "@/lib/layout"
import { cn } from "@/lib/utils"

/**
 * What a reply is doing, in one line under it: the chat's own activity line, and the line a
 * question the agent asked waits on while this screen holds its form in the composer slot. A turn
 * that wants the reader, not the host, says so without a loader: nothing is working.
 */
export function StatusLine({
  text,
  waiting,
  children,
}: {
  text?: string
  /** The turn wants the reader, not the host: its words stand and no loader turns beside them. */
  waiting?: boolean
  children?: ReactNode
}) {
  const working = Boolean(text) && !waiting
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
      {text && (
        <span className="min-w-0 truncate" data-slot="status-words">
          {text}
        </span>
      )}
      {children}
    </div>
  )
}
