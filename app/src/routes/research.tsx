import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate, useParams } from "react-router"
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  BookAIcon,
  BookMarkedIcon,
  BookOpenTextIcon,
  CheckIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  FileTextIcon,
  ListChecksIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Bot } from "@/components/bot"
import { BotPicker } from "@/components/chat/bot-picker"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import {
  Evidence,
  GlossaryCanvas,
  GuideCanvas,
  MakingCanvas,
  NowReading,
  QuizCanvas,
  StageList,
  StageStrip,
} from "@/components/research"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { getActiveProfile } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { useLarge } from "@/lib/media"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import {
  FORMATS,
  MISSION_TYPES,
  SOURCE_KINDS,
  createMission,
  makeFormat,
  proposeOutline,
  startMission,
  updateMission,
  useMission,
  useMissions,
  type Mission,
  type MissionType,
  type OutputFormat,
} from "@/lib/research"
import { useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"

const FORMAT_ICONS: Record<OutputFormat, typeof BookOpenTextIcon> = {
  guide: BookOpenTextIcon,
  quiz: ListChecksIcon,
  glossary: BookAIcon,
}

const useActiveBotId = () => useLiveQuery(getActiveProfile, [])?.botId

const formatName = (format: OutputFormat) => FORMATS.find((f) => f.id === format)!.name

/** Research: start a mission from a question, and the missions so far by what they need. */
export function ResearchPage() {
  const openDrawer = useOpenDrawer()
  const navigate = useNavigate()
  const missions = useMissions()
  const profile = useLiveQuery(getActiveProfile, [])
  const [type, setType] = useState<MissionType>("learn")
  const [text, setText] = useState("")
  const example = MISSION_TYPES.find((t) => t.id === type)!.example

  const start = () => {
    if (!text.trim()) return
    const mission = createMission(text)
    setText("")
    navigate(`/research/${mission.id}`)
  }

  const needsYou = missions.filter((m) => m.stage === "brief" || m.stage === "scope")
  const working = missions.filter((m) => ["reading", "drafting", "reviewing"].includes(m.stage))
  const ready = missions.filter((m) => m.stage === "delivered")

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
          <h1 className="flex flex-1 items-center gap-2 text-xl font-semibold tracking-tight">
            Research
            <ExperimentalBadge />
          </h1>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))] md:pt-10">
        <section className="flex flex-col gap-4">
          <h2 className="text-center text-2xl font-semibold tracking-tight md:text-3xl">
            What do you want to understand?
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              start()
            }}
            className="flex flex-col gap-3"
          >
            {profile && (
              <div>
                <BotPicker profile={profile} />
              </div>
            )}
            <InputGroup className="bg-background shadow-lg shadow-black/5 has-[textarea]:rounded-[1.75rem] dark:bg-input/30">
              <InputGroupTextarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    start()
                  }
                }}
                placeholder={example}
                rows={2}
                className="max-h-48 min-h-16 px-5 pt-4 pb-2 text-base md:text-[15px]"
                aria-label="What to research"
              />
              <InputGroupAddon align="block-end" className="px-2.5 pt-0 pb-1.5">
                <span className="flex-1" />
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  className="size-11 rounded-full"
                  disabled={!text.trim()}
                  aria-label="Start"
                >
                  <ArrowUpIcon />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <MissionTypes value={type} onChange={setType} />
        </section>

        <MissionGroup title="Needs you" missions={needsYou} />
        <MissionGroup title="Researching" missions={working} />
        <MissionGroup title="Ready" missions={ready} />
      </div>
    </div>
  )
}

/** The seven kinds of mission; only Learn & understand can be picked so far. */
function MissionTypes({
  value,
  onChange,
}: {
  value: MissionType
  onChange: (type: MissionType) => void
}) {
  return (
    <div
      className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0"
      role="radiogroup"
      aria-label="Mission type"
    >
      {MISSION_TYPES.map((type) => {
        const Icon = type.icon
        const active = value === type.id
        return (
          <button
            key={type.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={!type.ready}
            onClick={() => (type.ready ? onChange(type.id) : toast(`${type.name} is coming soon`))}
            className={cn(
              "flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : type.ready
                  ? "hover:bg-muted"
                  : "border-dashed text-muted-foreground",
            )}
          >
            <Icon className="size-4" />
            {type.name}
            {!type.ready && (
              <span className="rounded-full bg-muted px-1.5 text-[11px] leading-5 font-medium">
                Soon
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function missionLine(mission: Mission) {
  switch (mission.stage) {
    case "brief":
      return "Check the brief"
    case "scope":
      return "Approve the outline"
    case "reading":
      return `Reading sources · ${mission.read} so far`
    case "drafting":
      return `Drafting · ${mission.found} sources`
    case "reviewing":
      return "Reviewing"
    default:
      return mission.formats.map(formatName).join(", ")
  }
}

function MissionGroup({ title, missions }: { title: string; missions: Mission[] }) {
  const navigate = useNavigate()
  const now = useNow()
  if (!missions.length) return null
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-sm font-medium text-muted-foreground">
        {title}
        <span
          className={cn(
            "rounded-full px-1.5 text-xs leading-5 font-semibold tabular-nums",
            title === "Needs you" ? "bg-warning/15 text-warning" : "bg-muted",
          )}
        >
          {missions.length}
        </span>
      </h2>
      <ul className="flex flex-col gap-2">
        {missions.map((mission) => {
          const Icon = FORMAT_ICONS[mission.format]
          const waiting = mission.stage === "brief" || mission.stage === "scope"
          const busy = !waiting && mission.stage !== "delivered"
          return (
            <li key={mission.id}>
              <button
                type="button"
                onClick={() => navigate(`/research/${mission.id}`)}
                className="flex min-h-16 w-full items-center gap-3 rounded-3xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
              >
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-2xl",
                    waiting ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
                  )}
                >
                  {busy ? <Spinner className="size-5" /> : <Icon className="size-5" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{mission.title}</span>
                  <span className="truncate text-sm text-muted-foreground">
                    {missionLine(mission)}
                  </span>
                </span>
                <span className="shrink-0 self-start pt-0.5 text-xs text-muted-foreground">
                  {formatRelative(mission.createdAt, now)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const STEPS = ["Brief", "Scope", "Research", "Ready"]

function stepOf(mission: Mission) {
  if (mission.stage === "brief") return 0
  if (mission.stage === "scope") return 1
  if (mission.stage === "delivered") return 3
  return 2
}

/** Brief, Scope, Research, Ready, as a row of dots joined by lines. */
function Steps({ mission }: { mission: Mission }) {
  const at = stepOf(mission)
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {STEPS.map((step, index) => (
        <li key={step} className="flex flex-1 items-center gap-2 last:flex-none">
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs font-medium whitespace-nowrap",
              index > at ? "text-muted-foreground" : "text-foreground",
            )}
            aria-current={index === at ? "step" : undefined}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-[11px] font-semibold",
                index < at && "bg-primary text-primary-foreground",
                index === at && "bg-primary/15 text-primary ring-1 ring-primary",
                index > at && "bg-muted",
              )}
            >
              {index < at ? <CheckIcon className="size-3" /> : index + 1}
            </span>
            <span className={cn(index !== at && "max-sm:sr-only")}>{step}</span>
          </span>
          {index < STEPS.length - 1 && (
            <span
              className={cn("h-0.5 flex-1 rounded-full", index < at ? "bg-primary" : "bg-border")}
            />
          )}
        </li>
      ))}
    </ol>
  )
}

/** One mission: the brief, then the Scope Gate, then the output building and delivered. */
export function MissionPage() {
  const { id = "" } = useParams()
  const mission = useMission(id)
  const { up } = useNav()
  const back = useCallback(() => up("/research"), [up])
  useEffect(() => setBackGuard(() => (back(), true)), [back])

  if (!mission)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        This mission is gone.
      </div>
    )

  const researching = !["brief", "scope"].includes(mission.stage)
  return researching ? (
    <WorkView mission={mission} onBack={back} />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <MissionHeader mission={mission} onBack={back} />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <Steps mission={mission} />
        <p className="ml-auto max-w-[85%] rounded-3xl rounded-br-lg bg-muted px-4 py-2.5">
          {mission.input}
        </p>
        {mission.stage === "brief" ? (
          <ReadBack mission={mission} />
        ) : (
          <>
            <BriefSummary mission={mission} />
            <ScopeGate mission={mission} />
          </>
        )}
      </div>
    </div>
  )
}

function MissionHeader({
  mission,
  onBack,
  actions,
}: {
  mission: Mission
  onBack: () => void
  actions?: ReactNode
}) {
  const type = MISSION_TYPES.find((t) => t.id === mission.type)!
  return (
    <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="icon-lg"
          className="size-11 shrink-0 rounded-full"
          onClick={onBack}
          aria-label="Back to Research"
        >
          <ArrowLeftIcon />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-base font-semibold tracking-tight">{mission.title}</h1>
          <p className="truncate text-xs text-muted-foreground">{type.name}</p>
        </div>
        {actions}
      </div>
    </header>
  )
}

/** A choice between a few options as one row of pills. */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; name: string; icon?: typeof BookOpenTextIcon }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div className="flex gap-1 rounded-full bg-muted p-1" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const Icon = option.icon
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            onClick={() => onChange(option.id)}
            className={cn(
              "flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors",
              value === option.id && "bg-background text-foreground shadow-sm",
            )}
          >
            {Icon && <Icon className="size-4" />}
            {option.name}
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  )
}

/** What the bot took from the question, all of it editable, before anything is committed. */
function ReadBack({ mission }: { mission: Mission }) {
  const botId = useActiveBotId()
  const [goal, setGoal] = useState(mission.goal)
  const [format, setFormat] = useState(mission.format)
  const [audience, setAudience] = useState(mission.audience)
  const [depth, setDepth] = useState(mission.depth)
  const save = () =>
    updateMission(mission.id, {
      goal,
      format,
      audience,
      depth,
      stage: "scope",
      outline: proposeOutline(mission),
    })

  return (
    <div className="flex flex-col gap-5 rounded-3xl border bg-card p-4 md:p-5">
      <h2 className="flex items-center gap-2.5 font-semibold">
        <Bot id={botId} className="size-7" />
        Here's what I understood
      </h2>
      <Field label="Goal">
        <Textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          className="min-h-20 leading-6"
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Format</span>
        <Segmented
          label="Format"
          options={FORMATS.map((f) => ({ ...f, icon: FORMAT_ICONS[f.id] }))}
          value={format}
          onChange={setFormat}
        />
      </div>
      <Field label="Audience">
        <Input
          value={audience}
          onChange={(event) => setAudience(event.target.value)}
          className="h-11"
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Depth</span>
        <Segmented
          label="Depth"
          options={[
            { id: "overview", name: "Overview" },
            { id: "deep", name: "In depth" },
          ]}
          value={depth}
          onChange={setDepth}
        />
      </div>
      <Button size="lg" className="h-11 rounded-full md:self-end md:px-6" onClick={save}>
        Continue
      </Button>
    </div>
  )
}

/** The confirmed brief, folded to two lines, with a way back into it. */
function BriefSummary({ mission }: { mission: Mission }) {
  const Icon = FORMAT_ICONS[mission.format]
  return (
    <div className="flex items-start gap-3 rounded-3xl border bg-card px-4 py-3">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="line-clamp-2 text-sm">{mission.goal}</p>
        <p className="truncate text-xs text-muted-foreground">
          {formatName(mission.format)} · {mission.depth === "deep" ? "In depth" : "Overview"} ·{" "}
          {mission.audience}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-lg"
        className="-my-1 -mr-2 size-11 shrink-0 rounded-full"
        onClick={() => updateMission(mission.id, { stage: "brief" })}
        aria-label="Edit the brief"
      >
        <PencilIcon />
      </Button>
    </div>
  )
}

const MAX_POINTS = 6

/** The Scope Gate: the outline and the kinds of source, and nothing is researched until approved. */
function ScopeGate({ mission }: { mission: Mission }) {
  const botId = useActiveBotId()
  const [points, setPoints] = useState(mission.outline)
  const [sources, setSources] = useState(mission.sources)
  const filled = points.filter((p) => p.trim())

  return (
    <div className="flex flex-col gap-5 rounded-3xl border bg-card p-4 md:p-5">
      <h2 className="flex items-center gap-2.5 font-semibold">
        <Bot id={botId} className="size-7" />
        <span className="flex-1">Outline</span>
        <span className="text-sm font-normal text-muted-foreground">
          {filled.length} of {MAX_POINTS}
        </span>
      </h2>
      <ol className="-mt-2 flex flex-col gap-1">
        {points.map((point, index) => (
          <li key={index} className="flex items-start gap-2">
            <span className="mt-2.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
              {index + 1}
            </span>
            <Textarea
              value={point}
              rows={1}
              onChange={(event) =>
                setPoints(points.map((p, i) => (i === index ? event.target.value : p)))
              }
              aria-label={`Point ${index + 1}`}
              className="min-h-11 rounded-2xl border-transparent bg-transparent px-2 py-2.5 leading-6 hover:border-input dark:bg-transparent"
            />
            <Button
              variant="ghost"
              size="icon-lg"
              className="size-11 shrink-0 rounded-full text-muted-foreground"
              onClick={() => setPoints(points.filter((_, i) => i !== index))}
              aria-label={`Remove point ${index + 1}`}
            >
              <XIcon />
            </Button>
          </li>
        ))}
        <li>
          <Button
            variant="ghost"
            className="h-11 rounded-full px-2 text-muted-foreground"
            disabled={points.length >= MAX_POINTS}
            onClick={() => setPoints([...points, ""])}
          >
            <PlusIcon data-icon="inline-start" />
            Add a point
          </Button>
        </li>
      </ol>
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Sources</h2>
        <div className="flex flex-wrap gap-2">
          {SOURCE_KINDS.map((kind) => {
            const on = sources.includes(kind.id)
            return (
              <button
                key={kind.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() =>
                  setSources(on ? sources.filter((s) => s !== kind.id) : [...sources, kind.id])
                }
                className={cn(
                  "flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors",
                  on ? "border-primary/40 bg-primary/10 font-medium" : "text-muted-foreground",
                )}
              >
                {on ? (
                  <CheckIcon className="size-4 text-primary" />
                ) : (
                  <PlusIcon className="size-4" />
                )}
                {kind.name}
              </button>
            )
          })}
        </div>
      </div>
      <Button
        size="lg"
        className="h-11 rounded-full md:self-end md:px-6"
        disabled={!filled.length || !sources.length}
        onClick={() => {
          updateMission(mission.id, { outline: filled, sources })
          startMission(mission.id)
        }}
      >
        Approve and start research
      </Button>
    </div>
  )
}

/**
 * Research under way, then delivered: the stages (and once delivered, the contents and the
 * evidence) on the left from tablet width, the output building in the centre.
 */
function WorkView({ mission, onBack }: { mission: Mission; onBack: () => void }) {
  // The panes need the room beside the sidebar, so a tablet gets the phone layout.
  const wide = useLarge()
  const delivered = mission.stage === "delivered"
  const [format, setFormat] = useState<OutputFormat>(mission.formats[0] ?? mission.format)
  const [pane, setPane] = useState<"contents" | "evidence">("contents")
  const [cited, setCited] = useState<string>()
  const [sheet, setSheet] = useState(false)
  const shown: OutputFormat | "making" =
    mission.making && !mission.formats.includes(format) ? "making" : format

  const cite = (id: string) => {
    setCited(id)
    if (wide) setPane("evidence")
    else setSheet(true)
    window.setTimeout(
      () => document.getElementById(`claim-${id}`)?.scrollIntoView({ block: "center" }),
      wide ? 0 : 350,
    )
  }

  const make = (next: OutputFormat) => {
    makeFormat(mission.id, next)
    setFormat(next)
  }

  const actions = delivered && (
    <>
      {!wide && (
        <Button
          variant="outline"
          size="icon-lg"
          className="size-11 rounded-full"
          onClick={() => {
            setCited(undefined)
            setSheet(true)
          }}
          aria-label="Sources"
        >
          <BookMarkedIcon />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon-lg"
              className="size-11 rounded-full"
              aria-label="Export"
            />
          }
        >
          <DownloadIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem className="min-h-11" onClick={() => toast("Copied")}>
            <ClipboardCopyIcon />
            Copy
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onClick={() => toast("Saved as Markdown")}>
            <FileTextIcon />
            Markdown
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onClick={() => toast("Saved as PDF")}>
            <DownloadIcon />
            PDF
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MissionHeader mission={mission} onBack={onBack} actions={actions} />
      <div className="flex min-h-0 flex-1">
        {wide && (
          <aside className="flex w-72 shrink-0 flex-col gap-5 overflow-y-auto border-r px-4 pt-2 pb-6 lg:w-80">
            {delivered ? (
              <>
                <Segmented
                  label="Pane"
                  options={[
                    { id: "contents", name: "Contents" },
                    { id: "evidence", name: "Sources" },
                  ]}
                  value={pane}
                  onChange={setPane}
                />
                {pane === "evidence" ? (
                  <Evidence active={cited} />
                ) : (
                  <Contents mission={mission} format={format} />
                )}
              </>
            ) : (
              <>
                <StageList mission={mission} />
                {mission.stage === "reading" && <NowReading mission={mission} />}
              </>
            )}
          </aside>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] md:px-8">
            {!wide && !delivered && <StageStrip mission={mission} />}
            {!wide && mission.stage === "reading" && <NowReading mission={mission} />}
            {delivered && (
              <FormatTabs mission={mission} value={format} onChange={setFormat} onMake={make} />
            )}
            <div className="flex flex-col gap-1">
              <h2 className="text-2xl font-semibold tracking-tight">{mission.title}</h2>
              <p className="text-sm text-muted-foreground">
                {formatName(shown === "making" ? format : shown)} · {mission.found || "…"} sources ·
                For {mission.audience.charAt(0).toLowerCase() + mission.audience.slice(1)}
              </p>
            </div>
            {shown === "making" ? (
              <MakingCanvas found={mission.found} />
            ) : shown === "quiz" ? (
              <QuizCanvas onCite={cite} />
            ) : shown === "glossary" ? (
              <GlossaryCanvas onCite={cite} />
            ) : (
              <GuideCanvas mission={mission} onCite={cite} />
            )}
          </div>
        </main>
      </div>
      <Popup open={sheet} onOpenChange={setSheet} side>
        <PopupContent initialFocus={false}>
          <PopupHeader>
            <PopupTitle>Sources</PopupTitle>
          </PopupHeader>
          <div className="px-4 pb-2">
            <Evidence active={cited} />
          </div>
        </PopupContent>
      </Popup>
    </div>
  )
}

/** The formats made so far, and the ones that can still be made from the same ledger. */
function FormatTabs({
  mission,
  value,
  onChange,
  onMake,
}: {
  mission: Mission
  value: OutputFormat
  onChange: (format: OutputFormat) => void
  onMake: (format: OutputFormat) => void
}) {
  const made = [...mission.formats, ...(mission.making ? [mission.making] : [])]
  const more = FORMATS.filter((f) => !made.includes(f.id))
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
      {made.map((id) => {
        const Icon = FORMAT_ICONS[id]
        const making = id === mission.making
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={value === id}
            className={cn(
              "flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors",
              value === id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {making ? <Spinner className="size-4" /> : <Icon className="size-4" />}
            {formatName(id)}
          </button>
        )
      })}
      {more.map((format) => (
        <button
          key={format.id}
          type="button"
          onClick={() => onMake(format.id)}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-dashed px-4 text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          <PlusIcon className="size-4" />
          Make a {format.name.toLowerCase()}
        </button>
      ))}
    </div>
  )
}

function Contents({ mission, format }: { mission: Mission; format: OutputFormat }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <CheckIcon className="size-4 text-success" />
          Researched {mission.found} sources
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          <CheckIcon className="size-4 text-success" />
          Every claim checked
        </span>
      </div>
      {format === "guide" && (
        <ol className="flex flex-col gap-0.5">
          {mission.outline.map((point, index) => (
            <li
              key={point}
              className="flex min-h-11 items-center gap-3 rounded-2xl px-3 text-sm hover:bg-muted"
            >
              <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1">{point}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
