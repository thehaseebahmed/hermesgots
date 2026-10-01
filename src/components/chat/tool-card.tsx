import { useEffect, useState } from "react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

function useElapsed(tool: ToolEvent) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (tool.status !== "running") return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [tool.status])
  return (tool.endedAt ?? now) - tool.startedAt
}

export function ToolCard({ tool }: { tool: ToolEvent }) {
  const running = tool.status === "running"
  const elapsed = useElapsed(tool)
  const hasDetail = tool.label && tool.label !== tool.tool

  return (
    <Collapsible className="w-full rounded-3xl border bg-card">
      <CollapsibleTrigger
        className="group/tool flex w-full items-center gap-3 px-4 py-3 text-left outline-none"
        disabled={!hasDetail}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full",
            running ? "text-muted-foreground" : "bg-primary text-primary-foreground",
          )}
        >
          {running ? (
            <Spinner className="size-4" />
          ) : (
            <CheckIcon className="size-3.5" strokeWidth={3} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {tool.emoji ? `${tool.emoji} ` : ""}
            {tool.tool}
          </span>
          {hasDetail && (
            <span className="block truncate font-mono text-xs text-muted-foreground group-data-[panel-open]/tool:hidden">
              {tool.label}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(elapsed)}
        </span>
        {hasDetail && (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/tool:rotate-180" />
        )}
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <pre className="overflow-x-auto px-4 pb-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {tool.label}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
