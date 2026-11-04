import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  BotIcon,
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
import {
  WORK_ROW_GAP,
  WorkLabel,
  WorkMark,
  WorkNote,
  WorkRow,
  WorkRuler,
} from "@/components/chat/work-row"
import { Button } from "@/components/ui/button"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { usePopupDrawer, usePopupForm } from "@/lib/popup-form"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"
import { formatDuration } from "@/lib/format"
import { readEnvelope } from "@/lib/json-envelope"
import {
  callOutcome,
  kindOf,
  phrases,
  todoTarget,
  TODO_TOOLS,
  type Kind,
  type KindId,
} from "@/lib/tools"
import { FAILED, REFUSED } from "@/lib/words"
import { cn } from "@/lib/utils"
import { fittingPhrases, summary } from "@/lib/phrase-fit"

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

/**
 * How many phrases of the summary fit on the row's line, with "(+N)" for the rest (ADR 0096). The room
 * is the row's width less the box after the words and the row's gap, and it is memoised: an observer
 * reports every frame of a width transition, and a fit whose room has not changed has nothing to
 * answer. A face that lands after the first fit moves the words without moving the row, so
 * `document.fonts.ready` asks once more.
 */
function useFittingPhrases(parts: string[]) {
  const row = useRef<HTMLButtonElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const ruler = useRef<HTMLSpanElement>(null)
  const after = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(parts.length)
  const key = parts.join("|")
  const room = useRef(0)
  const fit = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const button = row.current
    const measure = ruler.current
    if (!button || !measure) return
    fit.current = () => {
      const next = Math.floor(
        button.clientWidth - (after.current?.getBoundingClientRect().width ?? 0) - WORK_ROW_GAP,
      )
      if (next === room.current) return
      room.current = next
      const count = fittingPhrases(parts, next, (candidate) => {
        measure.textContent = candidate
        return measure.offsetWidth
      })
      if (count !== undefined) setShown(count)
    }
    room.current = 0
    fit.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `parts` is rebuilt every render; `key` is its content
  }, [key])
  useLayoutEffect(() => {
    const button = row.current
    if (!button) return
    const observer = new ResizeObserver(() => fit.current())
    observer.observe(button)
    let live = true
    if (document.fonts)
      void document.fonts.ready.then(() => {
        room.current = 0
        if (live) fit.current()
      })
    return () => {
      live = false
      observer.disconnect()
    }
  }, [])
  return { row, text, ruler, after, shown: Math.min(shown, parts.length) }
}

function whyFailed(tool: ToolEvent) {
  if (tool.status !== "failed") return undefined
  const outcome = tool.result ? callOutcome(tool.tool, tool.result) : undefined
  return tool.error ?? (outcome?.state === "failed" ? outcome.reason : undefined) ?? FAILED
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
    return <XIcon className="size-5 text-destructive" strokeWidth={2.5} aria-label={FAILED} />
  return <Icon className="size-5 text-muted-foreground" />
}

function ToolDetail({ tool, onBack }: { tool: ToolEvent; onBack: () => void }) {
  const elapsed = useElapsed(tool)
  // The back button sits over a drawer's header: a sheet's drag handle dismisses it instead, so the
  // button would float over the handle band.
  const wide = usePopupForm() !== "sheet"
  const status =
    tool.status === "running"
      ? "Running"
      : tool.status === "failed"
        ? FAILED
        : tool.status === "refused"
          ? REFUSED
          : "Completed"
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
        <div className="flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
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
  line,
  onSelect,
}: {
  tools: ToolEvent[]
  /** The run's whole line, uncut: the sheet holds every call, so it owes no count of them. */
  line: string
  onSelect: (index: number) => void
}) {
  const face = useCodeFace()
  const mono = useMonoFace()
  return (
    <>
      <PopupHeader className="pb-2">
        <PopupTitle>{line}</PopupTitle>
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
                        <span>
                          {tool.status === "running"
                            ? kind.doing
                            : tool.status === "refused"
                              ? REFUSED
                              : kind.verb}
                        </span>{" "}
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
  const { row, text, ruler, after, shown } = useFittingPhrases(parts)
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
        afterRef={after}
        data-slot="tool-group"
        aria-label={failed ? `${full}, failed` : full}
        onClick={() => setOpen(true)}
        working={running}
        after={
          <>
            <WorkRuler ref={ruler} />
            <WorkMark />
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
            <ToolList tools={tools} line={full} onSelect={setSelectedIndex} />
          )}
        </PopupContent>
      </Popup>
    </>
  )
}
