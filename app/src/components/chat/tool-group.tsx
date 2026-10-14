import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  FilePlusIcon,
  GitPullRequestArrowIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  SquareTerminalIcon,
  ListTodoIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"

import { Details } from "@/components/chat/tool-card"
import { Button } from "@/components/ui/button"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"
import { formatDuration } from "@/lib/format"
import { useWide } from "@/lib/media"
import { failureReason, kindOf, phrases, todoTarget, TODO_TOOLS, type KindId } from "@/lib/tools"

function useElapsed(tool: ToolEvent) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (tool.status !== "running") return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [tool.status])
  return (tool.endedAt ?? now) - tool.startedAt
}

const ICONS: Record<KindId, LucideIcon> = {
  ran: SquareTerminalIcon,
  read: EyeIcon,
  edited: PencilIcon,
  created: FilePlusIcon,
  code: SearchIcon,
  web: GlobeIcon,
  browsed: GlobeIcon,
  plan: ListTodoIcon,
  pr: GitPullRequestArrowIcon,
  used: WrenchIcon,
}

const sentence = (parts: string[]) =>
  parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(", ")

/** The summary with the first `shown` phrases, and how many more there are when it's cut short. */
const summary = (parts: string[], shown = parts.length) =>
  sentence(parts.slice(0, shown)) + (shown < parts.length ? ` (+${parts.length - shown})` : "")

/** How many phrases of the summary fit on the row's line, with "(+N)" standing in for the rest. */
function useFittingPhrases<T extends HTMLElement>(parts: string[], deps: unknown[] = []) {
  const row = useRef<T>(null)
  const text = useRef<HTMLSpanElement>(null)
  const ruler = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(parts.length)
  const key = parts.join("|")
  useLayoutEffect(() => {
    const button = row.current
    const measure = ruler.current
    if (!button || !measure) return
    const fit = () => {
      let taken = 0
      let siblings = 0
      for (const child of button.children) {
        if (child === text.current || child === measure) continue
        taken += child.getBoundingClientRect().width
        siblings++
      }
      // The row's gap-2 sits between every item, the text included.
      const room = button.clientWidth - taken - siblings * 8
      for (let count = parts.length; count > 1; count--) {
        measure.textContent = summary(parts, count)
        if (measure.offsetWidth <= room) return setShown(count)
      }
      setShown(1)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(button)
    return () => observer.disconnect()
    // `parts` is rebuilt every render; its content is what `key` stands for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps])
  return { row, text, ruler, shown: Math.min(shown, parts.length) }
}

/** Why a failed call failed: what Hermes said, else its result's error, for the row under its name. */
function whyFailed(tool: ToolEvent) {
  if (tool.status !== "failed") return undefined
  return tool.error ?? failureReason(tool.tool, tool.result) ?? "Failed"
}

const MAX_NAME = 26

/** A file's name, with the middle dropped when it's long: the start and the extension survive. */
function shortName(path: string) {
  const name = path.split("/").filter(Boolean).at(-1) ?? path
  if (name.length <= MAX_NAME) return name
  const tail = Math.ceil(MAX_NAME / 2) - 1
  return `${name.slice(0, MAX_NAME - tail - 1)}…${name.slice(-tail)}`
}

const FILE_TOOLS = new Set(["read_file", "write_file", "patch"])

function targetOf(tool: ToolEvent) {
  if (TODO_TOOLS.has(tool.tool)) return todoTarget(tool)
  const label = tool.label && tool.label !== tool.tool ? tool.label : ""
  if (!label) return tool.tool
  return FILE_TOOLS.has(tool.tool) ? shortName(label) : label
}

function DiffBadge({ tool }: { tool: ToolEvent }) {
  if (tool.added === undefined) return null
  return (
    <span className="flex shrink-0 overflow-hidden rounded-md font-mono text-sm tabular-nums">
      <span className="bg-success/15 px-2 py-0.5 text-success">+{tool.added}</span>
      <span className="bg-destructive/15 px-2 py-0.5 text-destructive">−{tool.removed ?? 0}</span>
    </span>
  )
}

function StatusIcon({ tool, icon: Icon }: { tool: ToolEvent; icon: LucideIcon }) {
  if (tool.status === "running") return <Spinner className="size-5 text-muted-foreground" />
  if (tool.status === "failed")
    return <XIcon className="size-5 text-destructive" strokeWidth={2.5} aria-label="Failed" />
  return <Icon className="size-5 text-muted-foreground" />
}

function ToolDetail({ tool, onBack }: { tool: ToolEvent; onBack: () => void }) {
  const elapsed = useElapsed(tool)
  // The back button sits over the header, which only exists from tablet width up: on a phone the
  // sheet's drag handle dismisses it, so the button would float over the handle band.
  const wide = useWide()
  const status =
    tool.status === "running" ? "Running" : tool.status === "failed" ? "Failed" : "Completed"
  return (
    <>
      <PopupHeader className="items-center px-6 pb-3 text-center md:px-16">
        {wide && (
          <Button
            variant="ghost"
            size="icon-lg"
            className="absolute top-3 left-3 size-11"
            onClick={onBack}
          >
            <ArrowLeftIcon />
            <span className="sr-only">Back</span>
          </Button>
        )}
        <PopupTitle className="max-w-full truncate">
          {tool.emoji ? `${tool.emoji} ` : ""}
          {tool.tool}
        </PopupTitle>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {status} · {formatDuration(elapsed)}
          <DiffBadge tool={tool} />
        </div>
      </PopupHeader>
      <div className="flex flex-col gap-6 px-6">
        <Details tool={tool} />
      </div>
    </>
  )
}

function ToolList({ tools, onSelect }: { tools: ToolEvent[]; onSelect: (index: number) => void }) {
  const parts = phrases(tools)
  const { row, text, ruler, shown } = useFittingPhrases<HTMLHeadingElement>(parts)
  return (
    <>
      <PopupHeader className="px-14 pb-2 text-center">
        <PopupTitle ref={row} className="relative truncate" title={summary(parts)}>
          <span ref={text}>{summary(parts, shown)}</span>
          <span ref={ruler} className="invisible absolute w-max whitespace-nowrap" aria-hidden />
        </PopupTitle>
      </PopupHeader>
      <ol className="flex flex-col px-6 pt-2">
        {tools.map((tool, index) => {
          const kind = kindOf(tool)
          const reason = whyFailed(tool)
          return (
            <li key={`${tool.toolCallId}-${index}`} className="flex gap-3">
              <div className="relative w-7 shrink-0">
                <div className="flex h-11 items-center justify-center">
                  <StatusIcon tool={tool} icon={ICONS[kind.id]} />
                </div>
                {/* Runs from under this row's icon to the next one's. */}
                {index < tools.length - 1 && (
                  <div className="absolute top-10 -bottom-1 left-1/2 w-px -translate-x-1/2 bg-border" />
                )}
              </div>
              <button
                type="button"
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => onSelect(index)}
              >
                <span className="flex min-w-0 flex-1 flex-col py-2">
                  <span className="truncate">
                    {kind.id === "plan" ? (
                      <>
                        {tool.status === "running"
                          ? `${kind.doing} todos`
                          : `Todos ${kind.verb.toLowerCase()}`}
                        {targetOf(tool) && (
                          <span className="text-muted-foreground">, {targetOf(tool)}</span>
                        )}
                      </>
                    ) : (
                      <>
                        <span>{tool.status === "running" ? kind.doing : kind.verb}</span>{" "}
                        <span className="font-mono text-[13px] text-muted-foreground">
                          {targetOf(tool)}
                        </span>
                      </>
                    )}
                  </span>
                  {reason && <span className="truncate text-sm text-destructive">{reason}</span>}
                </span>
                <DiffBadge tool={tool} />
              </button>
            </li>
          )
        })}
      </ol>
    </>
  )
}

/** Tool calls that ran back to back: one row, which opens the list, and each call opens its details. */
export function ToolGroup({ tools }: { tools: ToolEvent[] }) {
  const [open, setOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState<number>()
  const selected = selectedIndex !== undefined ? tools[selectedIndex] : undefined
  const running = tools.some((t) => t.status === "running")
  const failures = tools.filter((t) => t.status === "failed")
  const failed = failures.length > 0
  const parts = phrases(tools)
  const { row, text, ruler, shown } = useFittingPhrases<HTMLButtonElement>(parts, [running, failed])
  // From tablet width up the details open in the same sheet, behind a back button; on a phone they
  // open as a sheet stacked on the list's, dismissed back to it.
  const wide = useWide()
  const detail = !wide ? selected : undefined
  // Kept while the stacked sheet animates out, so it doesn't empty first.
  const [last, setLast] = useState<ToolEvent | undefined>()
  if (detail && detail !== last) setLast(detail)
  const shownDetail = detail ?? last
  return (
    <>
      <button
        ref={row}
        type="button"
        aria-label={summary(parts)}
        className="relative flex min-h-11 w-full items-center gap-2 text-left text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => setOpen(true)}
      >
        {running && <Spinner className="size-4 shrink-0" />}
        {failed && !running && (
          <XIcon className="size-4 shrink-0 text-destructive" strokeWidth={3} aria-label="Failed" />
        )}
        <span ref={text} className="min-w-0 truncate">
          {summary(parts, shown)}
        </span>
        <span ref={ruler} className="invisible absolute w-max whitespace-nowrap" aria-hidden />
        <ChevronRightIcon className="size-4 shrink-0" />
      </button>
      {failed && (
        <p className="-mt-2 truncate pb-1 pl-6 text-sm text-destructive">
          {failures.length === 1 ? whyFailed(failures[0]) : `${failures.length} calls failed`}
        </p>
      )}
      <Popup
        side
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSelectedIndex(undefined)
        }}
      >
        {/* On a phone the details open as a sheet stacked on this one; it renders inside the
            parent sheet's tree so Base UI registers the nesting. */}
        {!wide && (
          <Popup
            open={Boolean(detail)}
            onOpenChange={(next) => !next && setSelectedIndex(undefined)}
          >
            <PopupContent>
              {shownDetail && (
                <ToolDetail tool={shownDetail} onBack={() => setSelectedIndex(undefined)} />
              )}
            </PopupContent>
          </Popup>
        )}
        <PopupContent>
          {wide && selected ? (
            <ToolDetail tool={selected} onBack={() => setSelectedIndex(undefined)} />
          ) : (
            <ToolList tools={tools} onSelect={setSelectedIndex} />
          )}
        </PopupContent>
      </Popup>
    </>
  )
}
