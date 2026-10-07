import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  FilePlusIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  SquareTerminalIcon,
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

function useElapsed(tool: ToolEvent) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (tool.status !== "running") return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [tool.status])
  return (tool.endedAt ?? now) - tool.startedAt
}

interface Kind {
  icon: LucideIcon
  verb: string
  /** How the title counts calls of this kind: a fixed phrase, or a noun to count. */
  title: string | { one: string; many: string }
}

const FILE = { one: "a file", many: "files" }
const RAN: Kind = {
  icon: SquareTerminalIcon,
  verb: "Ran",
  title: { one: "a command", many: "commands" },
}
const READ: Kind = { icon: EyeIcon, verb: "Read", title: FILE }
const EDITED: Kind = { icon: PencilIcon, verb: "Edited", title: FILE }
const CREATED: Kind = { icon: FilePlusIcon, verb: "Created", title: FILE }
const CODE: Kind = { icon: SearchIcon, verb: "Searched", title: "code" }
const WEB: Kind = { icon: GlobeIcon, verb: "Searched", title: "the web" }
const BROWSED: Kind = { icon: GlobeIcon, verb: "Browsed", title: { one: "a page", many: "pages" } }
const USED: Kind = { icon: WrenchIcon, verb: "Used", title: { one: "a tool", many: "tools" } }

const KINDS: Record<string, Kind> = {
  terminal: RAN,
  execute_code: RAN,
  browser_exec: RAN,
  read_file: READ,
  search_files: CODE,
  web_search: WEB,
  web_extract: WEB,
}

function kindOf(tool: ToolEvent): Kind {
  if (tool.tool === "write_file") return CREATED
  if (tool.tool === "patch") return tool.created ? CREATED : EDITED
  if (tool.tool.startsWith("browser_")) return BROWSED
  return KINDS[tool.tool] ?? USED
}

/** "Ran a command", "read a file", "searched code": each kind once, in the order it first appears. */
function phrases(tools: ToolEvent[]) {
  const counts = new Map<Kind, number>()
  for (const tool of tools) {
    const kind = kindOf(tool)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts].map(([kind, count]) => {
    const noun =
      typeof kind.title === "string"
        ? kind.title
        : count === 1
          ? kind.title.one
          : `${count} ${kind.title.many}`
    return `${kind.verb} ${noun}`
  })
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
  const status =
    tool.status === "running" ? "Running" : tool.status === "failed" ? "Failed" : "Completed"
  return (
    <>
      <PopupHeader className="items-center px-16 pb-3 text-center">
        <Button
          variant="ghost"
          size="icon-lg"
          className="absolute top-3 left-3 size-11"
          onClick={onBack}
        >
          <ArrowLeftIcon />
          <span className="sr-only">Back</span>
        </Button>
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

function ToolList({ tools, onSelect }: { tools: ToolEvent[]; onSelect: (id: string) => void }) {
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
          return (
            <li key={tool.toolCallId} className="flex gap-3">
              <div className="relative w-7 shrink-0">
                <div className="flex h-11 items-center justify-center">
                  <StatusIcon tool={tool} icon={kind.icon} />
                </div>
                {/* Runs from under this row's icon to the next one's. */}
                {index < tools.length - 1 && (
                  <div className="absolute top-10 -bottom-1 left-1/2 w-px -translate-x-1/2 bg-border" />
                )}
              </div>
              <button
                type="button"
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => onSelect(tool.toolCallId)}
              >
                <span className="min-w-0 flex-1 truncate">
                  <span>{kind.verb}</span>{" "}
                  <span className="font-mono text-[13px] text-muted-foreground">
                    {targetOf(tool)}
                  </span>
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
  const [selectedId, setSelectedId] = useState<string>()
  const selected = tools.find((t) => t.toolCallId === selectedId)
  const running = tools.some((t) => t.status === "running")
  const failed = tools.some((t) => t.status === "failed")
  const parts = phrases(tools)
  const { row, text, ruler, shown } = useFittingPhrases<HTMLButtonElement>(parts, [running, failed])
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
      <Popup
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSelectedId(undefined)
        }}
      >
        <PopupContent>
          {selected ? (
            <ToolDetail tool={selected} onBack={() => setSelectedId(undefined)} />
          ) : (
            <ToolList tools={tools} onSelect={setSelectedId} />
          )}
        </PopupContent>
      </Popup>
    </>
  )
}
