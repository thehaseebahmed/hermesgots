import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"
import { formatDuration } from "@/lib/format"

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
  const [open, setOpen] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)

  // Only measure while collapsed: opening hides the inline label, which would end the overflow.
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || open) return
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [open, tool.label])

  const expandable = Boolean(hasDetail) && (overflowing || open)

  return (
    <Collapsible className="w-full" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="group/tool flex min-h-11 w-full items-center gap-2 text-left text-sm outline-none"
        disabled={!expandable}
      >
        {running ? (
          <Spinner className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <CheckIcon className="size-4 shrink-0 text-primary" strokeWidth={3} />
        )}
        <span ref={textRef} className="min-w-0 flex-1 truncate">
          <span className="font-medium">
            {tool.emoji ? `${tool.emoji} ` : ""}
            {tool.tool}
          </span>
          {hasDetail && (
            <span className="text-muted-foreground group-data-[panel-open]/tool:hidden">
              : {tool.label}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(elapsed)}
        </span>
        {expandable && (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/tool:rotate-180" />
        )}
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <p className="pb-2 pl-6 text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {tool.label}
          </p>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
