import { WorkLabel, WorkRow, WorkSign } from "@/components/chat/work-row"
import { subagentCountLabel } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * The **Subagent count** — how many subagents a session has at work — drawn inside a reply's
 * status line rather than as a row of its own (ADR 0070): the line's suffix while the turn works or
 * waits, and the line's only words once the turn is done and they still run. It wears the info blue
 * in both forms, the one thing in the cluster a reader can press, and turns a loader in that blue
 * only where it stands alone and is all the line is for. Pressing it opens the subagent sheet — the
 * only way to reach subagents whose cards the thread no longer shows.
 */
export function SubagentCount({
  count,
  onOpen,
  place,
  className,
}: {
  count: number
  onOpen: () => void
  /**
   * Where it sits on the line: the suffix of its words, alone where only it is left, or alone and
   * turning its own loader in the blue because nothing else keeps the line live (ADR 0070).
   */
  place: "suffix" | "alone" | "alone-loading"
  className?: string
}) {
  if (count <= 0) return null
  // Alone it is a work row like the Thinking and Running rows around it, and holds the line's own
  // shape; as a suffix it is the words' tail and the line's loader serves the pair.
  if (place !== "suffix")
    return (
      <WorkRow
        before={place === "alone-loading" ? <WorkSign /> : null}
        onClick={onOpen}
        className={cn("w-auto max-w-full self-start text-info hover:underline", className)}
      >
        <WorkLabel>{subagentCountLabel(count)}</WorkLabel>
      </WorkRow>
    )
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-1.5 rounded-full text-sm text-info underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="truncate">{subagentCountLabel(count)}</span>
    </button>
  )
}
