import type { ReactNode } from "react"

import { useCodeFace } from "@/components/chat/code-face"
import { SubagentCount } from "@/components/chat/subagent-count"
import { WORK_ROW_CLASS, WorkSign } from "@/components/chat/work-row"
import { CATCHING_ACTIVITY, THINKING_ACTIVITY, WRITING_ACTIVITY } from "@/lib/format"
import type { BusyKind } from "@/lib/busy-words"
import type { FootLine } from "@/lib/thinking"
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
  className,
  children,
}: {
  text?: string
  /** What the rotating word is drawn from, so a reply keeps its own while it streams. */
  seed?: string
  className?: string
  children?: ReactNode
}) {
  const kind = text ? KIND_OF.get(text) : undefined
  const word = useBusyWord(kind, seed) ?? text
  const face = useCodeFace()
  return (
    <div
      className={cn(REPLY_INSET, WORK_ROW_CLASS, "w-auto", face, className)}
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

/**
 * The line a thread draws, once (ADR 0076): what `statusLineOf` / `threadLineOf` decided the row
 * says, and the count of subagents at work where that decision put it — riding the words as a
 * suffix after the line's own dot, or standing alone with the line's loader. Every caller draws the
 * row through here, so the reply's foot and the thread's own row cannot word or colour it
 * differently.
 */
export function LineRow({
  line,
  count,
  onOpen,
  seed,
  className,
}: {
  line: FootLine
  /** How many subagents the session has at work. */
  count: number
  /** Where a press on the count leads; without it the count is not drawn. */
  onOpen?: () => void
  seed?: string
  className?: string
}) {
  const suffixed = line.count === "suffix"
  const place = suffixed ? "suffix" : line.countLoader ? "alone-loading" : "alone"
  return (
    <StatusLine text={line.text} seed={seed} className={className}>
      {line.count !== "none" && onOpen && (
        <>
          {suffixed && (
            <span aria-hidden data-slot="status-separator" className="text-info">
              ·
            </span>
          )}
          <SubagentCount
            count={count}
            onOpen={onOpen}
            place={place}
            className={suffixed ? "-my-2.5" : undefined}
          />
        </>
      )}
    </StatusLine>
  )
}
