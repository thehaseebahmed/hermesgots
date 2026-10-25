import { Spinner } from "@/components/ui/spinner"
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
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-1.5 rounded-full text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {spinner && <Spinner className="size-4" />}
      <span className="truncate">{subagentsLine(count)}</span>
    </button>
  )
}
