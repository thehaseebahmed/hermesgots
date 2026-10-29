import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronRightIcon,
  ClockIcon,
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

import { useCodeFace, useMonoFace } from "@/components/chat/code-face"
import { StepRail } from "@/components/chat/step-rail"
import { Details } from "@/components/chat/tool-card"
import { WorkRow, WorkNote, WorkLabel, WorkSign } from "@/components/chat/work-row"
import { Button } from "@/components/ui/button"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { usePopupDrawer, usePopupForm } from "@/lib/popup-form"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"
import { formatDuration } from "@/lib/format"
import { readEnvelope } from "@/lib/json-envelope"
import {
  failureReason,
  kindOf,
  phrases,
  todoTarget,
  TODO_TOOLS,
  type Kind,
  type KindId,
} from "@/lib/tools"
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
  cron: ClockIcon,
  subagent: BotIcon,
  listed: BotIcon,
  steered: BotIcon,
  stopped: BotIcon,
  used: WrenchIcon,
}

const sentence = (parts: string[]) =>
  parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(", ")

/** The summary with the first `shown` phrases, and how many more there are when it's cut short. */
const summary = (parts: string[], shown = parts.length) =>
  sentence(parts.slice(0, shown)) + (shown < parts.length ? ` (+${parts.length - shown})` : "")

/** How many phrases of the summary fit on the row's line, with "(+N)" standing in for the rest. */
function useFittingPhrases(parts: string[], deps: unknown[] = []) {
  const row = useRef<HTMLButtonElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const ruler = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(parts.length)
  const key = parts.join("|")
  const fit = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const button = row.current
    const measure = ruler.current
    if (!button || !measure) return
    fit.current = () => {
      let taken = 0
      let siblings = 0
      for (const child of button.children) {
        if (child === text.current || child === measure) continue
        taken += child.getBoundingClientRect().width
        siblings++
      }
      // The row's gap sits between every item, the text included, so each sibling past the label
      // costs its own width and one gap: `clientWidth` counts the padding the words never get.
      const gap = parseFloat(getComputedStyle(button).columnGap) || 0
      const room = button.clientWidth - taken - siblings * gap
      for (let count = parts.length; count > 1; count--) {
        measure.textContent = summary(parts, count)
        if (measure.offsetWidth <= room) return setShown(count)
      }
      setShown(1)
    }
    fit.current()
    // `parts` is rebuilt every render; its content is what `key` stands for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps])
  // A fresh observer delivers the button's size once, so re-creating one per phrase change ran the
  // fit twice; observing once keeps a change to a single fit.
  useLayoutEffect(() => {
    const button = row.current
    if (!button) return
    const observer = new ResizeObserver(() => fit.current())
    observer.observe(button)
    return () => observer.disconnect()
  }, [])
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

/**
 * What a call ran on, for its row: a todo call's count, a file's short name, else the label it
 * carried — and nothing where that label carries no words worth showing. A pull request call's
 * transcript label is its arguments as JSON, and a cron call's label is the action word its own verb
 * already says, so neither is put in the row's mouth. Only a label that reads as an envelope is
 * suppressed: a command that happens to open on `{` is the words it is.
 */
function targetOf(tool: ToolEvent, kind: Kind) {
  if (TODO_TOOLS.has(tool.tool)) return todoTarget(tool)
  if (kind.id === "cron") return ""
  const label = (tool.label ?? "").trim()
  if (!label || label === tool.tool || readEnvelope(label)) return ""
  return FILE_TOOLS.has(tool.tool) ? shortName(label) : label
}

/** The words a kind's row names where the call's label has none: "a cron job", "a pull request". */
const fixedNoun = (kind: Kind, tool: ToolEvent) =>
  typeof kind.title === "string" ? kind.title : tool.tool

function DiffBadge({ tool }: { tool: ToolEvent }) {
  const mono = useMonoFace()
  if (tool.added === undefined) return null
  return (
    <span className={cn("flex shrink-0 overflow-hidden rounded-md text-sm tabular-nums", mono)}>
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
  // The back button sits over a drawer's header: a sheet's drag handle dismisses it instead, so the
  // button would float over the handle band.
  const wide = usePopupForm() !== "sheet"
  const status =
    tool.status === "running" ? "Running" : tool.status === "failed" ? "Failed" : "Completed"
  return (
    <>
      <PopupHeader className="pb-3 pl-6 md:pl-16">
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
        <PopupTitle>
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

function ToolList({
  tools,
  label,
  tip,
  onSelect,
}: {
  tools: ToolEvent[]
  /** The row's own line, so the pop-up names the run exactly as the row does. */
  label: string
  /** Every phrase, uncut, for the heading's tooltip. */
  tip: string
  onSelect: (index: number) => void
}) {
  const face = useCodeFace()
  const mono = face ?? "font-mono"
  return (
    <>
      <PopupHeader className="pb-2">
        <PopupTitle title={tip}>{label}</PopupTitle>
      </PopupHeader>
      <ol className="flex flex-col px-6 pt-2">
        {tools.map((tool, index) => {
          const kind = kindOf(tool)
          const target = targetOf(tool, kind)
          const reason = whyFailed(tool)
          return (
            <li key={`${tool.toolCallId}-${index}`} className="flex gap-3">
              <StepRail last={index === tools.length - 1}>
                <StatusIcon tool={tool} icon={ICONS[kind.id]} />
              </StepRail>
              <button
                type="button"
                className={cn(
                  "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  face,
                )}
                onClick={() => onSelect(index)}
              >
                <span className="flex min-w-0 flex-1 flex-col py-2">
                  <span className="truncate">
                    {kind.id === "plan" ? (
                      <>
                        {tool.status === "running"
                          ? `${kind.doing} todos`
                          : `Todos ${kind.verb.toLowerCase()}`}
                        {target && <span className="text-muted-foreground">, {target}</span>}
                      </>
                    ) : (
                      <>
                        <span>{tool.status === "running" ? kind.doing : kind.verb}</span>{" "}
                        {target ? (
                          <span className={cn(mono, "text-[13px] text-muted-foreground")}>
                            {target}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{fixedNoun(kind, tool)}</span>
                        )}
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
  const { row, text, ruler, shown } = useFittingPhrases(parts, [running, failed])
  // One line for the row and the header of the pop-up it opens, so the two never disagree.
  const full = summary(parts)
  const label = summary(parts, shown)
  // From tablet width up the details open in the same sheet, behind a back button; on a phone they
  // open as a sheet stacked on the list's, dismissed back to it.
  const wide = usePopupDrawer()
  const detail = !wide ? selected : undefined
  // Kept while the stacked sheet animates out, so it doesn't empty first.
  const [last, setLast] = useState<ToolEvent | undefined>()
  if (detail && detail !== last) setLast(detail)
  const shownDetail = detail ?? last
  const failedCount = failures.length
  return (
    <>
      <WorkRow
        ref={row}
        data-slot="tool-group"
        aria-label={failed ? `${full}, failed` : full}
        onClick={() => setOpen(true)}
        before={running ? <WorkSign /> : failed ? <WorkSign failed /> : null}
        after={
          <>
            <span ref={ruler} className="invisible absolute w-max whitespace-nowrap" aria-hidden />
            <ChevronRightIcon className="size-4 shrink-0" />
          </>
        }
      >
        <WorkLabel ref={text}>{label}</WorkLabel>
      </WorkRow>
      {failed && (
        <WorkNote className="text-destructive" data-slot="tool-group-reason">
          {failedCount === 1 ? whyFailed(failures[0]) : `${failedCount} calls failed`}
        </WorkNote>
      )}
      <Popup
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSelectedIndex(undefined)
        }}
      >
        {/* As a sheet, the details open as a sheet stacked on this one; it renders inside the
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
            <ToolList tools={tools} label={label} tip={full} onSelect={setSelectedIndex} />
          )}
        </PopupContent>
      </Popup>
    </>
  )
}
