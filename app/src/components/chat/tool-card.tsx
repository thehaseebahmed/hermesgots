import { useEffect, useState, useSyncExternalStore } from "react"
import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"
import { formatDuration } from "@/lib/format"

const INPUT_TITLES: Record<string, string> = {
  terminal: "Command",
  execute_code: "Code",
  browser_exec: "Code",
}

// Tablet width and up (Tailwind's `md`) shows details inline; phones get a sheet.
const wide = window.matchMedia("(min-width: 768px)")
const subscribeWide = (onChange: () => void) => {
  wide.addEventListener("change", onChange)
  return () => wide.removeEventListener("change", onChange)
}
const useWide = () => useSyncExternalStore(subscribeWide, () => wide.matches)

function useElapsed(tool: ToolEvent) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (tool.status !== "running") return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [tool.status])
  return (tool.endedAt ?? now) - tool.startedAt
}

function Section({ title, children }: { title: string; children: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm text-muted-foreground">{title}</h3>
      <pre className="overflow-x-auto rounded-2xl bg-muted/60 p-4 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">
        {children}
      </pre>
    </section>
  )
}

function Details({ tool }: { tool: ToolEvent }) {
  const hasLabel = Boolean(tool.label) && tool.label !== tool.tool
  return (
    <>
      {hasLabel && <Section title={INPUT_TITLES[tool.tool] ?? "Input"}>{tool.label}</Section>}
      {tool.result && <Section title="Output">{tool.result}</Section>}
    </>
  )
}

export function ToolCard({ tool }: { tool: ToolEvent }) {
  const running = tool.status === "running"
  const elapsed = useElapsed(tool)
  const hasLabel = Boolean(tool.label) && tool.label !== tool.tool
  const wide = useWide()
  const [open, setOpen] = useState(false)

  const row = (
    <>
      {running ? (
        <Spinner className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <CheckIcon className="size-4 shrink-0 text-primary" strokeWidth={3} />
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">
          {tool.emoji ? `${tool.emoji} ` : ""}
          {tool.tool}
        </span>
        {hasLabel && <span className="text-muted-foreground"> {tool.label}</span>}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatDuration(elapsed)}
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/tool:rotate-90" />
    </>
  )
  const rowClass =
    "group/tool flex min-h-11 w-full items-center gap-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

  if (wide)
    return (
      <Collapsible className="w-full" open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className={rowClass}>{row}</CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-4 pt-1 pb-3 pl-6">
          <Details tool={tool} />
        </CollapsibleContent>
      </Collapsible>
    )

  return (
    <>
      <button type="button" className={rowClass} onClick={() => setOpen(true)}>
        {row}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="mx-auto max-h-[85dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl pb-[max(1.5rem,env(safe-area-inset-bottom))] data-[side=bottom]:border-t-0"
        >
          <SheetHeader className="relative items-center px-16 pb-2 text-center">
            <SheetClose
              render={
                <Button variant="ghost" size="icon-lg" className="absolute top-4 left-3 size-11" />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </SheetClose>
            <SheetTitle className="max-w-full truncate">
              {tool.emoji ? `${tool.emoji} ` : ""}
              {tool.tool}
            </SheetTitle>
            <SheetDescription>
              {running ? "Running" : "Completed"} · {formatDuration(elapsed)}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-6 px-6">
            <Details tool={tool} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
