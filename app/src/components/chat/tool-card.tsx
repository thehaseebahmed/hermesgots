import { Fragment, useEffect, useState, useSyncExternalStore } from "react"
import { Drawer } from "@base-ui/react/drawer"
import { CheckIcon, ChevronRightIcon, WrapTextIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"
import { formatDuration } from "@/lib/format"
import { formatTool, splitHtml, type Block } from "@/lib/highlight"

const INPUT_TITLES: Record<string, string> = {
  terminal: "Command",
  execute_code: "Code",
  browser_exec: "Code",
}
const INPUT_LANGUAGES: Record<string, string> = {
  terminal: "bash",
  execute_code: "python",
  browser_exec: "javascript",
}
/** Tools whose label is a file path, so the output is highlighted as that file. */
const FILE_TOOLS = new Set(["read_file", "write_file", "patch"])

/** Opens at about a third of the screen; dragging or scrolling it up takes the full height. */
const SNAP_POINTS = [0.35, 1]

// Tablet width and up (Tailwind's `md`) shows details inline; phones get a drawer.
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

function useFormatted(text: string, hint?: string) {
  const [formatted, setFormatted] = useState<{ text: string; blocks: Block[] }>()
  useEffect(() => {
    let cancelled = false
    void formatTool(text, hint).then((blocks) => {
      if (!cancelled) setFormatted({ text, blocks })
    })
    return () => {
      cancelled = true
    }
  }, [text, hint])
  return formatted?.text === text ? formatted.blocks : [{ code: text }]
}

/** Long lines wrap unless turned off; numbered rows keep their number beside each wrapped row. */
function CodeBlock({ block, toggle }: { block: Block; toggle?: boolean }) {
  const [wrap, setWrap] = useState(true)
  const text = wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"
  let body
  if (block.lines) {
    const rows = block.html ? splitHtml(block.html) : block.code.split("\n")
    body = (
      <div
        className={`grid ${wrap ? "grid-cols-[auto_minmax(0,1fr)]" : "w-max min-w-full grid-cols-[auto_max-content]"}`}
      >
        {block.lines.map((line, i) => (
          <Fragment key={i}>
            {/* Sticky, so the numbers stay put while unwrapped lines scroll sideways. */}
            <span
              className="sticky left-0 bg-muted pr-3 pl-4 text-right text-muted-foreground select-none"
              aria-hidden
            >
              {line}
            </span>
            {block.html ? (
              <code className={text} dangerouslySetInnerHTML={{ __html: rows[i] ?? "" }} />
            ) : (
              <code className={text}>{rows[i]}</code>
            )}
          </Fragment>
        ))}
      </div>
    )
  } else {
    body = block.html ? (
      <code className={`block ${text}`} dangerouslySetInnerHTML={{ __html: block.html }} />
    ) : (
      <code className={`block ${text}`}>{block.code}</code>
    )
  }
  return (
    <div className="relative">
      <pre
        className={`overflow-x-auto rounded-2xl bg-muted py-4 font-mono text-[13px] leading-relaxed ${block.lines ? "" : "pl-4"} ${toggle ? "pr-12" : "pr-4"}`}
      >
        {body}
      </pre>
      {toggle && (
        <Button
          variant="ghost"
          size="icon-lg"
          className="absolute top-0 right-0 size-11 rounded-2xl bg-muted text-muted-foreground aria-pressed:text-foreground"
          aria-label="Wrap lines"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapTextIcon />
        </Button>
      )}
    </div>
  )
}

function Section({
  title,
  text,
  hint,
  wrapToggle,
}: {
  title: string
  text: string
  hint?: string
  wrapToggle?: boolean
}) {
  const blocks = useFormatted(text, hint)
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm text-muted-foreground">{title}</h3>
      {blocks.map((block, i) => (
        <CodeBlock key={i} block={block} toggle={wrapToggle} />
      ))}
    </section>
  )
}

function Details({ tool }: { tool: ToolEvent }) {
  const hasLabel = Boolean(tool.label) && tool.label !== tool.tool
  return (
    <>
      {hasLabel && (
        <Section
          title={INPUT_TITLES[tool.tool] ?? "Input"}
          text={tool.label}
          hint={INPUT_LANGUAGES[tool.tool] ?? "plaintext"}
        />
      )}
      {tool.result && (
        <Section
          title="Output"
          wrapToggle
          text={tool.result}
          hint={FILE_TOOLS.has(tool.tool) && hasLabel ? tool.label : undefined}
        />
      )}
    </>
  )
}

export function ToolCard({ tool }: { tool: ToolEvent }) {
  const running = tool.status === "running"
  const elapsed = useElapsed(tool)
  const hasLabel = Boolean(tool.label) && tool.label !== tool.tool
  const wide = useWide()
  const [open, setOpen] = useState(false)
  const [snapPoint, setSnapPoint] = useState<Drawer.Root.SnapPoint | null>(SNAP_POINTS[0])

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
      <button
        type="button"
        className={rowClass}
        onClick={() => {
          setSnapPoint(SNAP_POINTS[0])
          setOpen(true)
        }}
      >
        {row}
      </button>
      <Drawer.Root
        open={open}
        onOpenChange={setOpen}
        snapPoints={SNAP_POINTS}
        snapPoint={snapPoint}
        onSnapPointChange={setSnapPoint}
      >
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-50 bg-black/40 opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:duration-0" />
          <Drawer.Viewport className="fixed inset-0 z-50 flex touch-none items-end justify-center">
            <Drawer.Popup className="group/drawer relative flex max-h-[calc(100dvh-env(safe-area-inset-top))] min-h-0 w-full max-w-xl [transform:translateY(calc(var(--drawer-snap-point-offset)+var(--drawer-swipe-movement-y)))] touch-none flex-col rounded-t-3xl bg-popover text-sm text-popover-foreground shadow-lg transition-transform duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] outline-none after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-12 after:bg-inherit data-ending-style:[transform:translateY(calc(100%+2px))] data-starting-style:[transform:translateY(calc(100%+2px))] data-swiping:duration-0">
              <div className="relative shrink-0 px-16 pt-2 pb-3 text-center select-none">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
                <Drawer.Close
                  render={
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      className="absolute top-4 left-3 size-11"
                    />
                  }
                >
                  <XIcon />
                  <span className="sr-only">Close</span>
                </Drawer.Close>
                <Drawer.Title className="truncate text-base font-medium">
                  {tool.emoji ? `${tool.emoji} ` : ""}
                  {tool.tool}
                </Drawer.Title>
                <Drawer.Description className="text-muted-foreground">
                  {running ? "Running" : "Completed"} · {formatDuration(elapsed)}
                </Drawer.Description>
              </div>
              {/* Scrolling the content natively (no drag handling of our own) also expands it. */}
              <Drawer.Content
                className="flex min-h-0 flex-1 touch-auto flex-col gap-6 overflow-y-auto overscroll-contain px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
                onScroll={(event) => {
                  if (snapPoint !== 1 && event.currentTarget.scrollTop > 0) setSnapPoint(1)
                }}
              >
                <Details tool={tool} />
              </Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  )
}
