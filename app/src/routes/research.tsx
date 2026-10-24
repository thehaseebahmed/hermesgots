import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Navigate, useLocation, useNavigate, useParams } from "react-router"
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  BookAIcon,
  BookMarkedIcon,
  BookOpenTextIcon,
  CheckIcon,
  ClipboardCopyIcon,
  EllipsisIcon,
  FileTextIcon,
  HistoryIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  ScaleIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { attempt } from "@/lib/attempt"
import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { CompareBriefForm, CompareScopeForm, MemoCanvas, SourceKinds } from "@/components/compare"
import { BotPicker } from "@/components/chat/bot-picker"
import { ModelPicker, PICKER_HEIGHT } from "@/components/chat/model-picker"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { ItemGroup, ItemRow, ItemSearch } from "@/components/item-list"
import { itemGroups } from "@/lib/item-groups"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import {
  Evidence,
  GlossaryCanvas,
  GuideCanvas,
  LedgerProvider,
  MakingCanvas,
  NowReading,
  QuizCanvas,
  StageStrip,
} from "@/components/research"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { Segmented } from "@/components/segmented"
import { db, getActiveProfile, rememberModel, type ModelChoice } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { getResearchWriters } from "@/lib/hermes"
import { useModelInfo } from "@/lib/model-info"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { itemToOpen, useRememberOpened, useResearchPane, type FeaturePane } from "@/lib/pane"
import {
  FORMATS,
  MAX_FOLLOWUPS,
  MAX_OUTLINE,
  MISSION_TYPES,
  approveScope,
  confirmBrief,
  createMission,
  deleteMission,
  editBrief,
  followUp,
  isWorking,
  makeFormat,
  needsYou,
  retryMission,
  revisionReason,
  rewriteMission,
  toMarkdown,
  useMission,
  useMissions,
  type Mission,
  type MissionType,
  type OutputFormat,
  type Revision,
} from "@/lib/research"
import { useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"

const FORMAT_ICONS: Record<OutputFormat, typeof BookOpenTextIcon> = {
  guide: BookOpenTextIcon,
  quiz: ListChecksIcon,
  glossary: BookAIcon,
  memo: ScaleIcon,
}

/** The picture of the bot running the mission. */
const useMissionBotId = (mission: Mission) =>
  useLiveQuery(() => db.profiles.get(mission.profileId), [mission.profileId])?.botId

const formatName = (format: OutputFormat) =>
  format === "memo" ? "Memo" : FORMATS.find((f) => f.id === format)!.name

/**
 * Research: start a mission from a question, and the missions so far by what they need. Where the
 * list stays beside the mission (see `useResearchPane`) this is the mission pane: the one opened
 * last, else the top one, else the question.
 */
export function ResearchPage() {
  const pane = useResearchPane()
  const { missions, loaded } = useMissions()
  const asked = Boolean((useLocation().state as { ask?: boolean } | null)?.ask)
  const now = useNow()
  if (!pane) return <ResearchHome />
  if (!loaded) return null
  const ids = missionGroups(missions, now).flatMap((g) => g.items.map((m) => m.id))
  const first = asked ? undefined : itemToOpen("research", ids)
  if (first) return <Navigate to={`/research/${first}`} replace />
  return <ResearchHome ask />
}

/** Missions by what they need, then by when they were asked. */
function missionGroups(missions: Mission[], now: number) {
  return itemGroups(
    missions,
    (m) => (needsYou(m) ? "waiting" : m.stage !== "delivered" ? "working" : undefined),
    (m) => m.createdAt,
    now,
  )
}

const matches = (mission: Mission, query: string) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const text = `${mission.title} ${mission.input}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/** The list kept on screen beside the open mission (see `useResearchPane`). */
export function ResearchPane({ pane }: { pane: FeaturePane }) {
  return <ResearchHome list={pane} />
}

function ResearchHome({ ask, list }: { ask?: boolean; list?: FeaturePane }) {
  const openDrawer = useOpenDrawer()
  const navigate = useNavigate()
  const { missions, unsupported } = useMissions()
  const profile = useLiveQuery(getActiveProfile, [])
  const [type, setType] = useState<MissionType>("learn")
  const [text, setText] = useState("")
  const [starting, setStarting] = useState(false)
  const example = MISSION_TYPES.find((t) => t.id === type)!.example
  const blocked = profile ? unsupported[profile.id] : undefined

  const start = async () => {
    if (!text.trim() || !profile || starting) return
    setStarting(true)
    let started: Mission | undefined
    await attempt("start the mission", async () => {
      started = await createMission(profile, text, type)
    })
    setStarting(false)
    if (!started) return
    setText("")
    navigate(`/research/${started.id}`, { replace: ask })
  }

  const [query, setQuery] = useState("")
  const now = useNow()
  const shown = missions.filter((m) => matches(m, query))
  const groups = missionGroups(shown, now)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {!ask && (
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
      )}

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))] md:pt-10">
        {!list && (
          <section className="flex flex-col gap-4">
            <h2 className="text-center text-2xl font-semibold tracking-tight md:text-3xl">
              What do you want to understand?
            </h2>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void start()
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
                      void start()
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
                    disabled={!text.trim() || !profile || Boolean(blocked) || starting}
                    aria-label="Start"
                  >
                    {starting ? <Spinner /> : <ArrowUpIcon />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </form>
            {blocked && <Banner>{blocked}</Banner>}
            <MissionTypes value={type} onChange={setType} />
          </section>
        )}

        {!ask && missions.length > 0 && (
          <div className="flex flex-col gap-6">
            <ItemSearch value={query} onChange={setQuery} label="Search research" />
            {shown.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No research matches.</p>
            )}
            {groups.map((group) => (
              <ItemGroup key={group.key} group={group}>
                {group.items.map((mission) => (
                  <li key={mission.id}>
                    <MissionRow
                      mission={mission}
                      now={now}
                      selected={mission.id === list?.selected}
                    />
                  </li>
                ))}
              </ItemGroup>
            ))}
          </div>
        )}
      </div>

      {list && (
        <div className="pointer-events-none sticky bottom-0 mt-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-2xl justify-end">
            <Button
              data-toast-above
              size="lg"
              className="pointer-events-auto h-12 rounded-full px-5 shadow-lg"
              onClick={() => navigate("/research", { replace: true, state: { ask: true } })}
            >
              <PlusIcon /> New research
            </Button>
          </div>
        </div>
      )}
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
  if (mission.error) return mission.error
  if (mission.busy === "brief") return "Reading your question"
  if (mission.busy === "outline") return "Proposing an outline"
  switch (mission.stage) {
    case "brief":
      return "Check the brief"
    case "scope":
      return "Approve the outline"
    case "reading":
      return `Reading sources · ${mission.found} so far`
    case "drafting":
      return `Drafting · ${mission.found} sources`
    case "reviewing":
      return "Reviewing"
    default: {
      const leader = mission.options.find((o) => o.id === mission.decision?.leader)
      if (leader) return `${leader.name} leads${mission.decision?.close ? " · close call" : ""}`
      return mission.formats.map(formatName).join(", ")
    }
  }
}

function MissionRow({
  mission,
  now,
  selected,
}: {
  mission: Mission
  now: number
  selected: boolean
}) {
  const navigate = useNavigate()
  // Beside the list a mission takes the place of the one open.
  const swap = Boolean(useResearchPane()?.open)
  const botId = useLiveQuery(() => db.profiles.get(mission.profileId), [mission.profileId])?.botId
  const Icon = FORMAT_ICONS[mission.format]
  return (
    <ItemRow
      icon={isWorking(mission) ? <Spinner /> : <Icon />}
      tone={needsYou(mission) ? "warning" : "success"}
      botId={botId}
      title={mission.title}
      when={formatRelative(mission.createdAt, now)}
      line={<span className="truncate">{missionLine(mission)}</span>}
      warn={Boolean(mission.error)}
      selected={selected}
      onOpen={() => navigate(`/research/${mission.id}`, { replace: swap })}
    />
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
  const { mission, loaded } = useMission(id)
  const { up } = useNav()
  const beside = Boolean(useResearchPane())
  const back = useCallback(() => up("/research"), [up])
  // Beside the list a mission is the top-level screen, so back leaves the app.
  useEffect(() => (beside ? undefined : setBackGuard(() => (back(), true))), [back, beside])
  useRememberOpened("research", mission?.id)

  if (!mission)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        {loaded ? "This mission is gone." : <Spinner className="size-6" />}
      </div>
    )

  const researching = !["brief", "scope"].includes(mission.stage)
  return researching ? (
    <WorkView mission={mission} onBack={beside ? undefined : back} />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <MissionHeader
        mission={mission}
        onBack={beside ? undefined : back}
        actions={<MissionMenu mission={mission} />}
      />
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

/** A step the plugin couldn't do, and the way to run it again. */
function MissionError({ mission }: { mission: Mission }) {
  const [retrying, setRetrying] = useState(false)
  if (!mission.error) return null
  return (
    <Banner
      action={
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-full"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true)
            await attempt("try again", () => retryMission(mission))
            setRetrying(false)
          }}
        >
          {retrying ? <Spinner /> : <RotateCcwIcon data-icon="inline-start" />}
          Try again
        </Button>
      }
    >
      {mission.error}
    </Banner>
  )
}

/** Copy and Markdown once something is made, Revisions, Missed something, Rewrite and Delete. */
function MissionMenu({
  mission,
  format,
  onRevisions,
}: {
  mission: Mission
  format?: OutputFormat
  onRevisions?: () => void
}) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [asking, setAsking] = useState(false)
  const [rewriting, setRewriting] = useState(false)
  const made = format && mission.formats.includes(format)
  const canAsk =
    mission.type === "learn" &&
    mission.stage === "delivered" &&
    Boolean(mission.followups) &&
    mission.outline.length < MAX_OUTLINE &&
    !mission.making
  // Learn & understand only; a rewrite that failed can be taken over by another model.
  const canRewrite =
    mission.type === "learn" &&
    Boolean(mission.revisions) &&
    !mission.making &&
    (mission.stage === "delivered" ||
      (Boolean(mission.error) && mission.pending?.reason === "rewrite"))

  const download = () => {
    const blob = new Blob([toMarkdown(mission, format!)], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${mission.title.replace(/[\\/:*?"<>|]+/g, "").trim() || "Research"}.md`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon-lg"
              className="size-11 rounded-full"
              aria-label="Mission options"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {made && (
            <>
              <DropdownMenuItem
                className="min-h-11"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(toMarkdown(mission, format))
                    .then(() => toast("Copied"))
                    .catch(() => toast.error("Couldn't copy."))
                }
              >
                <ClipboardCopyIcon />
                Copy
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-11" onClick={download}>
                <FileTextIcon />
                Markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {onRevisions && (
            <>
              <DropdownMenuItem className="min-h-11" onClick={onRevisions}>
                <HistoryIcon />
                Revisions
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {canAsk && (
            <DropdownMenuItem className="min-h-11" onClick={() => setAsking(true)}>
              <MessageCircleQuestionIcon />
              Missed something?
            </DropdownMenuItem>
          )}
          {canRewrite && (
            <DropdownMenuItem className="min-h-11" onClick={() => setRewriting(true)}>
              <SparklesIcon />
              Rewrite with another model
            </DropdownMenuItem>
          )}
          {(canAsk || canRewrite) && <DropdownMenuSeparator />}
          <DropdownMenuItem
            variant="destructive"
            className="min-h-11"
            onClick={() => setConfirming(true)}
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popup open={asking && canAsk} onOpenChange={setAsking}>
        <PopupContent>
          <PopupHeader>
            <PopupTitle>Missed something?</PopupTitle>
          </PopupHeader>
          <MissedQuestions mission={mission} onSent={() => setAsking(false)} />
        </PopupContent>
      </Popup>
      <Popup open={rewriting && canRewrite} onOpenChange={setRewriting}>
        <PopupContent initialFocus={false} fixedHeight={PICKER_HEIGHT}>
          <RewritePicker mission={mission} onDone={() => setRewriting(false)} />
        </PopupContent>
      </Popup>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this mission?</AlertDialogTitle>
            <AlertDialogDescription>
              Its sources, claims and everything written from them go too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                setConfirming(false)
                if (await attempt("delete the mission", () => deleteMission(mission)))
                  navigate("/research", { replace: true })
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The host's models to write the mission again with; the first row is the bot's own. */
function RewritePicker({ mission, onDone }: { mission: Mission; onDone: () => void }) {
  const profile = useLiveQuery(() => db.profiles.get(mission.profileId), [mission.profileId])
  const info = useModelInfo(profile)
  const [writers, setWriters] = useState<{ model: boolean; provider: boolean }>()
  useEffect(() => {
    if (!profile) return
    let cancelled = false
    void getResearchWriters(profile)
      .then((found) => !cancelled && setWriters(found))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [profile])

  const choose = (choice?: ModelChoice) => {
    onDone()
    if (choice && profile) void rememberModel(profile.id, choice)
    void attempt("rewrite it", () => rewriteMission(mission, choice))
  }

  return (
    <>
      {writers && !writers.model && (
        <Banner className="mx-6 mt-5 mb-0">
          This host doesn't let Gots pick the model. Allow it with{" "}
          <code className="font-mono text-[13px]">hermes plugins enable memento</code>.
        </Banner>
      )}
      <ModelPicker
        providers={info?.providers ?? []}
        fallback={{ label: "Default", model: info?.model }}
        recent={profile?.recentModels}
        choice={mission.writer}
        onChoose={choose}
      />
    </>
  )
}

function MissionHeader({
  mission,
  onBack,
  actions,
}: {
  mission: Mission
  onBack?: () => void
  actions?: ReactNode
}) {
  const type = MISSION_TYPES.find((t) => t.id === mission.type)!
  const profile = useLiveQuery(() => db.profiles.get(mission.profileId), [mission.profileId])
  const by = [profile?.name, mission.researcher?.model].filter(Boolean).join(" · ")
  return (
    <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
      <div className="flex items-center gap-3">
        {onBack && (
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 shrink-0 rounded-full"
            onClick={onBack}
            aria-label="Back to Research"
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-base font-semibold tracking-tight">{mission.title}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {[type.name, by].filter(Boolean).join(" · ")}
          </p>
        </div>
        {actions}
      </div>
    </header>
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

/** Placeholder lines inside a card while the plugin's model call works. */
function Thinking({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {label}
      </p>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "h-3 animate-pulse rounded-full bg-foreground/8 motion-reduce:animate-none",
            i === 2 ? "w-2/3" : "w-full",
          )}
        />
      ))}
    </div>
  )
}

/** What the bot took from the question, all of it editable, before anything is committed. */
function ReadBack({ mission }: { mission: Mission }) {
  const botId = useMissionBotId(mission)
  return (
    <div className="flex flex-col gap-5 rounded-3xl border bg-card p-4 md:p-5">
      <h2 className="flex items-center gap-2.5 font-semibold">
        <Bot id={botId} className="size-7" />
        Here's what I understood
      </h2>
      <MissionError mission={mission} />
      {mission.busy === "brief" ? (
        <Thinking label="Reading your question" />
      ) : (
        !mission.error &&
        (mission.type === "compare" ? (
          <CompareBriefForm key={mission.goal} mission={mission} />
        ) : (
          <BriefForm key={mission.goal} mission={mission} />
        ))
      )}
    </div>
  )
}

function BriefForm({ mission }: { mission: Mission }) {
  const [goal, setGoal] = useState(mission.goal)
  const [format, setFormat] = useState(mission.format)
  const [audience, setAudience] = useState(mission.audience)
  const [depth, setDepth] = useState(mission.depth)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    await attempt("save the brief", () => confirmBrief(mission, { goal, format, audience, depth }))
    setSaving(false)
  }

  return (
    <>
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
          options={FORMATS.map((f) => ({ id: f.id, label: f.name, icon: FORMAT_ICONS[f.id] }))}
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
            { id: "overview", label: "Overview" },
            { id: "deep", label: "In depth" },
          ]}
          value={depth}
          onChange={setDepth}
        />
      </div>
      <Button
        size="lg"
        className="h-11 rounded-full md:self-end md:px-6"
        disabled={!goal.trim() || !audience.trim() || saving}
        onClick={() => void save()}
      >
        {saving && <Spinner data-icon="inline-start" />}
        Continue
      </Button>
    </>
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
        disabled={Boolean(mission.busy)}
        onClick={() => void attempt("edit the brief", () => editBrief(mission))}
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
  const botId = useMissionBotId(mission)
  return (
    <div className="flex flex-col gap-5 rounded-3xl border bg-card p-4 md:p-5">
      <MissionError mission={mission} />
      {mission.busy === "outline" ? (
        <>
          <h2 className="flex items-center gap-2.5 font-semibold">
            <Bot id={botId} className="size-7" />
            Outline
          </h2>
          <Thinking label="Proposing an outline" />
        </>
      ) : (
        !mission.error &&
        (mission.type === "compare" ? (
          <CompareScopeForm key={mission.outline.join("\n")} mission={mission} botId={botId} />
        ) : (
          <ScopeForm key={mission.outline.join("\n")} mission={mission} botId={botId} />
        ))
      )}
    </div>
  )
}

function ScopeForm({ mission, botId }: { mission: Mission; botId?: string }) {
  const [points, setPoints] = useState(mission.outline)
  const [sources, setSources] = useState(mission.sources)
  const [starting, setStarting] = useState(false)
  const filled = points.filter((p) => p.trim())

  return (
    <>
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
        <SourceKinds value={sources} onChange={setSources} />
      </div>
      <Button
        size="lg"
        className="h-11 rounded-full md:self-end md:px-6"
        disabled={!filled.length || !sources.length || starting}
        onClick={async () => {
          setStarting(true)
          await attempt("start the research", () => approveScope(mission, filled, sources))
          setStarting(false)
        }}
      >
        {starting && <Spinner data-icon="inline-start" />}
        Approve and start research
      </Button>
    </>
  )
}

/**
 * Research under way, then delivered, as one reading column: the stage strip while it works, the
 * output building and delivered, and its sources and revisions in drawers.
 */
function WorkView({ mission, onBack }: { mission: Mission; onBack?: () => void }) {
  const delivered = mission.stage === "delivered"
  const [format, setFormat] = useState<OutputFormat>(mission.formats[0] ?? mission.format)
  // The Sources drawer, and the claim a tapped citation opened it on.
  const [sources, setSources] = useState<{ cited?: string }>()
  const [revisions, setRevisions] = useState(false)
  const [viewing, setViewing] = useState<number>()
  const main = useRef<HTMLElement>(null)

  // An earlier revision on show in place of the latest, read-only.
  const revision = mission.revisions?.find((r) => r.number === viewing && !isLatest(mission, r))
  const shown: Mission = revision
    ? {
        ...mission,
        outline: revision.outline,
        outputs: revision.outputs,
        stage: "delivered",
        making: undefined,
      }
    : mission
  const kept: OutputFormat[] = revision
    ? FORMATS.map((f) => f.id).filter((f) => revision.outputs[f]?.length)
    : []
  const compared = mission.type === "compare"
  const viewed = revision && !kept.includes(format) ? (kept[0] ?? format) : format
  const canvas: OutputFormat | "making" = revision
    ? viewed
    : !mission.formats.includes(format) && (mission.making === format || !delivered)
      ? format === "guide"
        ? "guide"
        : "making"
      : format
  const outputs = shown.outputs ?? {}
  const found = mission.ledger?.sources.length ?? 0
  const revised = (mission.revisions?.length ?? 0) > 1 || Boolean(mission.pending)

  const cite = (id: string) => setSources({ cited: id })

  const view = (number?: number) => {
    setViewing(number)
    setRevisions(false)
    main.current?.scrollTo({ top: 0 })
  }

  const make = async (next: OutputFormat) => {
    if (await attempt("make it", () => makeFormat(mission, next))) setFormat(next)
  }

  const actions = (
    <>
      {found > 0 && (
        <Button
          variant="outline"
          size="lg"
          className="h-11 rounded-full px-4"
          onClick={() => setSources({})}
          aria-label={`${found} sources`}
        >
          <BookMarkedIcon data-icon="inline-start" />
          {found}
          <span className="max-sm:hidden"> sources</span>
        </Button>
      )}
      <MissionMenu
        mission={mission}
        format={format}
        onRevisions={revised ? () => setRevisions(true) : undefined}
      />
    </>
  )

  return (
    <LedgerProvider ledger={mission.ledger}>
      <div className="flex min-h-0 flex-1 flex-col">
        <MissionHeader mission={mission} onBack={onBack} actions={actions} />
        <main ref={main} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] md:px-8">
            {!delivered && <StageStrip mission={mission} />}
            {mission.stage === "reading" && <NowReading mission={mission} />}
            <MissionError mission={mission} />
            {revision ? (
              <Banner
                tone="info"
                className="pr-28"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-full"
                    onClick={() => view(undefined)}
                  >
                    Latest
                  </Button>
                }
              >
                Revision {revision.number}: {revisionReason(revision)}
              </Banner>
            ) : (
              delivered &&
              !compared && (
                <FormatTabs mission={mission} value={format} onChange={setFormat} onMake={make} />
              )
            )}
            <div className="flex flex-col gap-1">
              <h2 className="text-2xl font-semibold tracking-tight">{mission.title}</h2>
              <p className="text-sm text-muted-foreground">
                {formatName(viewed)} · {mission.found || "…"} sources · For{" "}
                {mission.audience.charAt(0).toLowerCase() + mission.audience.slice(1)}
              </p>
            </div>
            {compared ? (
              <MemoCanvas mission={shown} onCite={cite} />
            ) : canvas === "making" ? (
              <MakingCanvas found={mission.found} />
            ) : canvas === "quiz" ? (
              <QuizCanvas questions={outputs.quiz ?? []} onCite={cite} />
            ) : canvas === "glossary" ? (
              <GlossaryCanvas terms={outputs.glossary ?? []} onCite={cite} />
            ) : (
              <GuideCanvas mission={shown} onCite={cite} />
            )}
          </div>
        </main>
        <Popup open={Boolean(sources)} onOpenChange={(open) => !open && setSources(undefined)}>
          <PopupContent initialFocus={false}>
            <PopupHeader>
              <PopupTitle>Sources</PopupTitle>
            </PopupHeader>
            <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <Evidence ledger={mission.ledger} active={sources?.cited} />
            </div>
          </PopupContent>
        </Popup>
        <Popup open={revisions && revised} onOpenChange={setRevisions}>
          <PopupContent initialFocus={false}>
            <PopupHeader>
              <PopupTitle>Revisions</PopupTitle>
            </PopupHeader>
            <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <Revisions mission={mission} viewing={revision?.number} onView={view} />
            </div>
          </PopupContent>
        </Popup>
      </div>
    </LedgerProvider>
  )
}

/** The latest revision is what the mission shows, unless it's being written again. */
const isLatest = (mission: Mission, revision: Revision) =>
  !mission.pending && revision.number === mission.revisions?.at(-1)?.number

/**
 * Questions the mission missed: the ones the model thinks it leaves open, to pick, and the user's
 * own. Sending them reads for them, then everything it made is written again around them.
 */
function MissedQuestions({ mission, onSent }: { mission: Mission; onSent: () => void }) {
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const room = Math.min(MAX_FOLLOWUPS, MAX_OUTLINE - mission.outline.length)
  const own = text.trim()
  const questions = [...picked, ...(own ? [own] : [])]
  const full = questions.length >= room
  const busy = sending || Boolean(mission.making)

  const send = async () => {
    if (!questions.length || questions.length > room || busy) return
    setSending(true)
    const sent = await attempt("ask it", () => followUp(mission, questions))
    setSending(false)
    if (sent) onSent()
  }

  return (
    <div className="flex flex-col gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {mission.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {mission.suggestions.map((question) => {
            const on = picked.includes(question)
            return (
              <button
                key={question}
                type="button"
                aria-pressed={on}
                disabled={!on && full}
                onClick={() =>
                  setPicked(on ? picked.filter((q) => q !== question) : [...picked, question])
                }
                className={cn(
                  "flex min-h-11 items-center gap-1.5 rounded-2xl border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50",
                  on ? "border-primary bg-primary/10 text-foreground" : "enabled:hover:bg-muted",
                )}
              >
                {on ? (
                  <CheckIcon className="size-4 shrink-0 text-primary" />
                ) : (
                  <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                {question}
              </button>
            )
          })}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <InputGroup className="bg-background has-[textarea]:rounded-[1.5rem] dark:bg-input/30">
          <InputGroupTextarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="What didn't it answer?"
            disabled={!own && picked.length >= room}
            rows={1}
            className="max-h-32 min-h-11 px-4 pt-3 pb-1 text-base md:text-[15px]"
            aria-label="A question it missed"
          />
          <InputGroupAddon align="block-end" className="px-2 pt-0 pb-1.5">
            <span className="flex-1 px-2 text-xs text-muted-foreground tabular-nums">
              {questions.length > 0 && `${questions.length} of ${room}`}
            </span>
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              className="size-11 rounded-full"
              disabled={!questions.length || questions.length > room || busy}
              aria-label="Research these"
            >
              {sending ? <Spinner /> : <ArrowUpIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
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
            {making && !mission.error ? (
              <Spinner className="size-4" />
            ) : (
              <Icon className="size-4" />
            )}
            {formatName(id)}
          </button>
        )
      })}
      {more.map((format) => (
        <button
          key={format.id}
          type="button"
          disabled={Boolean(mission.making)}
          onClick={() => onMake(format.id)}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-dashed px-4 text-sm text-muted-foreground transition-colors enabled:hover:bg-muted disabled:opacity-50"
        >
          <PlusIcon className="size-4" />
          Make a {format.name.toLowerCase()}
        </button>
      ))}
    </div>
  )
}

/** Each version the mission delivered and why it was written, newest first; one opens to read. */
function Revisions({
  mission,
  viewing,
  onView,
}: {
  mission: Mission
  viewing?: number
  onView: (number?: number) => void
}) {
  const now = useNow()
  const revisions = mission.revisions ?? []
  if (!revisions.length) return null
  const pending = mission.pending
  return (
    <ol className="flex flex-col gap-0.5">
      {pending && (
        <li className="flex min-h-11 items-start gap-3 rounded-2xl px-3 py-2 text-sm">
          <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">
            {revisions.length + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">
              {pending.reason === "followup"
                ? `Answering ${pending.questions?.map((q) => `“${q}”`).join(", ")}`
                : `Rewriting with ${mission.writer?.model ?? "the default model"}`}
            </span>
            <span className="block text-xs text-muted-foreground">
              {mission.error ? "Stopped" : RESEARCH_STAGE_NAMES[mission.stage]}
            </span>
          </span>
          {!mission.error && <Spinner className="mt-0.5 size-4 text-muted-foreground" />}
        </li>
      )}
      {[...revisions].reverse().map((revision) => {
        const latest = isLatest(mission, revision)
        const open = latest ? viewing === undefined : viewing === revision.number
        return (
          <li key={revision.number}>
            <button
              type="button"
              aria-pressed={open}
              onClick={() => onView(latest ? undefined : revision.number)}
              className="flex min-h-11 w-full items-start gap-3 rounded-2xl px-3 py-2 text-left text-sm transition-colors hover:bg-muted aria-pressed:bg-muted"
            >
              <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">
                {revision.number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{revisionReason(revision)}</span>
                <span className="block text-xs text-muted-foreground">
                  {[
                    latest && "Current",
                    `${revision.claims} claims`,
                    revision.at && formatRelative(revision.at, now),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

const RESEARCH_STAGE_NAMES: Record<Mission["stage"], string> = {
  brief: "Brief",
  scope: "Scope",
  reading: "Reading sources",
  drafting: "Writing",
  reviewing: "Reviewing",
  delivered: "Delivered",
}
