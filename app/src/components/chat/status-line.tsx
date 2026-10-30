import type { ReactNode } from "react"

import { useCodeFace } from "@/components/chat/code-face"
import { WORK_ROW_CLASS, WorkSign } from "@/components/chat/work-row"
import { CATCHING_ACTIVITY, THINKING_ACTIVITY, WRITING_ACTIVITY } from "@/lib/format"
import type { BusyKind } from "@/lib/busy-words"
import { REPLY_INSET } from "@/lib/layout"
import { useBusyWord } from "@/lib/use-busy-word"
import { cn } from "@/lib/utils"

/** The activity lines that are dressed in a rotating word; any other line stands as written. */
const KIND_OF = new Map<string, BusyKind>([
  [THINKING_ACTIVITY, "thinking"],
  [WRITING_ACTIVITY, "writing"],
  [CATCHING_ACTIVITY, "catching"],
])

/**
 * What a reply is doing, in one line under it: the chat's own activity line, and the line a
 * question the agent asked waits on while this screen holds its form in the composer slot. It turns
 * one loader whenever it has words to say, the wait words taking the busy words' place and keeping
 * it, since a waiting turn is still a live line; only its words rotate, so a rotating word means
 * "this is the live line" and nothing else. What it says, and whether it stands at all, is
 * `statusLineOf`'s to decide.
 */
export function StatusLine({
  text,
  seed = "",
  children,
}: {
  text?: string
  /** What the rotating word is drawn from, so a reply keeps its own while it streams. */
  seed?: string
  children?: ReactNode
}) {
  const kind = text ? KIND_OF.get(text) : undefined
  const word = useBusyWord(kind, seed) ?? text
  const face = useCodeFace()
  return (
    <div
      className={cn(REPLY_INSET, WORK_ROW_CLASS, "w-auto", face)}
      aria-live="polite"
      data-slot="status-line"
    >
      {word && <WorkSign />}
      {word && (
        <span className="min-w-0 truncate" data-slot="status-words">
          {word}
        </span>
      )}
      {children}
    </div>
  )
}
