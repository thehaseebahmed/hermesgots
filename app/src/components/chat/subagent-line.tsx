import { WorkLabel, WorkRow, WorkSign } from "@/components/chat/work-row"
import { subagentsLine } from "@/lib/agents"
import { cn } from "@/lib/utils"

/**
 * How many subagents a session has at work, as a line of its own: drawn by whichever row the thread
 * ends on, so it rides beside a streaming reply's activity words and stands at the thread's foot
 * under anything sent since. Pressing it opens the subagent sheet — the only way to reach subagents
 * whose cards the thread no longer shows.
 */
export function SubagentLine({
  count,
  onOpen,
  spinner = true,
  className,
}: {
  count: number
  onOpen: () => void
  spinner?: boolean
  className?: string
}) {
  if (count <= 0) return null
  // Alone it is a work row like the Thinking and Running rows around it; beside a status line's
  // words (`spinner` false) it is their suffix and the line's own loader serves both.
  if (spinner)
    return (
      <WorkRow
        before={<WorkSign />}
        onClick={onOpen}
        className={cn("w-auto max-w-full self-start text-info hover:underline", className)}
      >
        <WorkLabel>{subagentsLine(count)}</WorkLabel>
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
      <span className="truncate">{subagentsLine(count)}</span>
    </button>
  )
}
