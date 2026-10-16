import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router"
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardCopyIcon,
  DiamondIcon,
  EllipsisIcon,
  FileAudioIcon,
  FileTextIcon,
  FlagIcon,
  FolderIcon,
  GitBranchIcon,
  MailIcon,
  MenuIcon,
  MicIcon,
  NotebookPenIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SearchIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { FullscreenPopup, Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { formatRelative } from "@/lib/format"
import {
  askMeeting,
  clock,
  createMeeting,
  heardAt,
  isWorking,
  length,
  matchesMeeting,
  meetingLine,
  MOMENT_TITLES,
  parseTranscript,
  removeMeeting,
  retryMeeting,
  startAction,
  toMarkdown,
  topicAt,
  useMeeting,
  readyLine,
  useMeetingBot,
  useMeetingBots,
  useMeetingProjects,
  useMeetings,
  useMeetingsEnabled,
  type Mark,
  type Meeting,
  type MeetingProject,
  type Moment,
  type MomentKind,
  type Recap,
  type Topic,
} from "@/lib/meetings"
import { getActiveProfile, setActiveProfile } from "@/lib/db"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { useMeetingsPane, type MeetingsPane as PaneState } from "@/lib/pane"
import { useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"

/** Meetings is behind a Developer switch; with it off, its screens send you home. */
function Gate({ children }: { children: ReactNode }) {
  const enabled = useMeetingsEnabled()
  if (enabled === undefined) return null
  return enabled ? children : <Navigate to="/" replace />
}

/** A screen's sticky header: the drawer or back button, a title and what it can do. */
function Header({
  leading,
  title,
  subtitle,
  actions,
  className,
}: {
  leading: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-10 bg-background/80 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur",
        className,
      )}
    >
      <div className="mx-auto flex max-w-2xl items-center gap-3 px-4">
        {leading}
        <div className="flex min-w-0 flex-1 flex-col">
          {title}
          {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        {actions}
      </div>
    </header>
  )
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 shrink-0 rounded-full"
      onClick={onClick}
      aria-label={label}
    >
      <ArrowLeftIcon />
    </Button>
  )
}

/** Each topic's colour, in order, from the theme's status tokens. */
const TONES = [
  { span: "bg-info/45", dot: "bg-info" },
  { span: "bg-success/45", dot: "bg-success" },
  { span: "bg-warning/50", dot: "bg-warning" },
  { span: "bg-merged/40", dot: "bg-merged" },
]
const tone = (index: number) => TONES[index % TONES.length]

const MOMENT_LOOK: Record<MomentKind, { icon: typeof FlagIcon; color: string; label: string }> = {
  decision: { icon: DiamondIcon, color: "text-merged", label: "Decision" },
  action: { icon: CheckIcon, color: "text-primary", label: "Action" },
  open: { icon: FlagIcon, color: "text-warning", label: "Flag" },
}

function MomentIcon({ kind, className }: { kind: MomentKind; className?: string }) {
  const { icon: Icon, color } = MOMENT_LOOK[kind]
  return (
    <Icon
      aria-hidden
      className={cn("size-4 shrink-0", color, kind === "decision" && "fill-current", className)}
    />
  )
}

/** The bot's picture in a soft round frame. */
function BotAvatar({ botId, className }: { botId: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10",
        className,
      )}
    >
      <Bot id={botId} className="size-[85%]" />
    </span>
  )
}

/** Meetings: record one or add a recording, and every meeting so far by its project. */
export function MeetingsPage() {
  return (
    <Gate>
      <MeetingsList />
    </Gate>
  )
}

/** The list kept on screen beside the open meeting, from `xl` (see `useMeetingsPane`). */
export function MeetingsPane({ pane }: { pane: PaneState }) {
  return (
    <Gate>
      <MeetingsList pane={pane} />
    </Gate>
  )
}

/** Opening something from the list while one is already open takes its place in the history. */
function useSwap() {
  const navigate = useNavigate()
  const swap = Boolean(useMeetingsPane()?.open)
  return (to: string) => navigate(to, { replace: swap })
}

function MeetingsList({ pane }: { pane?: PaneState }) {
  const openDrawer = useOpenDrawer()
  const open = useSwap()
  const meetings = useMeetings()
  const bot = useMeetingBot()
  const bots = useMeetingBots()
  const activeId = useLiveQuery(async () => (await getActiveProfile())?.id, [])
  const [adding, setAdding] = useState(false)
  const [recording, setRecording] = useState(false)
  // A fresh form each time it opens.
  const [form, setForm] = useState(0)
  const [query, setQuery] = useState("")
  const [project, setProject] = useState<string>()
  const now = useNow()

  // Each project once, in the order of its newest meeting.
  const projects = [...new Map(meetings.map((m) => [m.projectId, m.projectName])).entries()]
  const shown = meetings.filter(
    (m) => (!project || m.projectId === project) && matchesMeeting(m, query),
  )
  const groups = meetingGroups(shown, now)
  const filtering = Boolean(query.trim() || project)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Header
        leading={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
        }
        title={
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            Meetings
            <ExperimentalBadge />
          </h1>
        }
      />

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <section className="relative overflow-hidden rounded-[2rem] border bg-radial-[at_25%_20%] from-primary/15 to-card to-70% p-5">
          <div className="flex items-center gap-4">
            <Bot id={bot.botId} animate className="size-20" />
            <p className="min-w-0 flex-1 text-lg leading-snug font-semibold tracking-tight">
              {readyLine(bot.botId)}
            </p>
          </div>
          {bots.length > 1 && (
            <div
              className="-mx-5 mt-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-5"
              role="group"
              aria-label="Bot"
            >
              {bots.map((option) => {
                const active = option.id === activeId
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => void setActiveProfile(option.id)}
                    className={cn(
                      "flex min-h-11 w-20 shrink-0 flex-col items-center gap-1 rounded-3xl border bg-background/70 px-2 py-2 text-xs font-medium transition-colors",
                      active ? "border-primary bg-primary/10" : "hover:bg-muted",
                    )}
                  >
                    <Bot id={option.botId} className="size-10" />
                    <span className="w-full truncate text-center">{option.name}</span>
                  </button>
                )
              })}
            </div>
          )}
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Button
              size="lg"
              className="h-12 rounded-full text-base"
              onClick={() => setRecording(true)}
            >
              <MicIcon data-icon="inline-start" />
              Record
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-12 rounded-full bg-background/70 text-base"
              onClick={() => {
                setForm((n) => n + 1)
                setAdding(true)
              }}
            >
              <UploadIcon data-icon="inline-start" />
              Upload
            </Button>
          </div>
        </section>

        {meetings.length > 0 && (
          <div className="flex flex-col gap-3">
            <InputGroup className="h-11 rounded-full bg-background dark:bg-input/30">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search meetings"
                aria-label="Search meetings"
                autoComplete="off"
                className="[&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-sm"
                    className="size-8 rounded-full"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                  >
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            {projects.length > 1 && (
              <div
                className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4"
                role="group"
                aria-label="Projects"
              >
                <Chip active={!project} onClick={() => setProject(undefined)}>
                  All
                </Chip>
                {projects.map(([id, name]) => (
                  <Chip
                    key={id}
                    active={project === id}
                    onClick={() => setProject(project === id ? undefined : id)}
                  >
                    <FolderIcon className="size-4" />
                    {name}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        )}

        {meetings.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No meetings yet.</p>
        )}
        {meetings.length > 0 && shown.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">No meetings match.</p>
            {filtering && (
              <Button
                variant="outline"
                className="h-11 rounded-full"
                onClick={() => {
                  setQuery("")
                  setProject(undefined)
                }}
              >
                Show all
              </Button>
            )}
          </div>
        )}

        {groups.map((group) => (
          <section key={group.label} className="flex flex-col gap-2" aria-label={group.label}>
            <h2 className="px-1 text-sm font-medium text-muted-foreground">{group.label}</h2>
            <ul className="flex flex-col">
              {group.meetings.map((meeting) => (
                <li key={meeting.id}>
                  <MeetingRow
                    meeting={meeting}
                    now={now}
                    showProject={!project}
                    selected={meeting.id === pane?.selected}
                    onOpen={() => open(`/meetings/${meeting.id}`)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <Upload key={form} open={adding} onOpenChange={setAdding} />
      {recording && (
        <Recorder
          onClose={() => setRecording(false)}
          onDone={(id) => {
            setRecording(false)
            open(`/meetings/${id}`)
          }}
        />
      )}
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

/**
 * Meetings by what they need: a failed one first, then any still being written up, then the rest
 * by when they happened.
 */
function meetingGroups(meetings: Meeting[], now: number) {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const today = day.getTime()
  const yesterday = today - 86_400_000
  const week = today - 6 * 86_400_000
  const labels = ["Needs you", "In progress", "Today", "Yesterday", "This week", "Earlier"]
  const of = (m: Meeting) =>
    m.stage === "failed"
      ? 0
      : isWorking(m)
        ? 1
        : m.createdAt >= today
          ? 2
          : m.createdAt >= yesterday
            ? 3
            : m.createdAt >= week
              ? 4
              : 5
  return labels
    .map((label, index) => ({ label, meetings: meetings.filter((m) => of(m) === index) }))
    .filter((g) => g.meetings.length)
}

/** A meeting's topics as one thin strip, each as long as it ran. */
function MiniStrip({ recap }: { recap: Recap }) {
  return (
    <span className="flex h-1.5 gap-0.5" aria-hidden>
      {recap.topics.map((topic, index) => (
        <span
          key={topic.id}
          className={cn("rounded-full", tone(index).dot)}
          style={{ flexGrow: Math.max(1, topic.end - topic.start) }}
        />
      ))}
    </span>
  )
}

const SOURCE_ICONS = { recording: MicIcon, upload: FileAudioIcon, transcript: FileTextIcon }
const SOURCE_LABELS = {
  recording: "Recorded",
  upload: "Uploaded recording",
  transcript: "Transcript",
}

function MeetingRow({
  meeting,
  now,
  showProject,
  selected,
  onOpen,
}: {
  meeting: Meeting
  now: number
  showProject: boolean
  selected: boolean
  onOpen: () => void
}) {
  const failed = meeting.stage === "failed"
  const Source = SOURCE_ICONS[meeting.source]
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected || undefined}
      className={cn(
        "-mx-2 flex min-h-16 w-[calc(100%+1rem)] items-start gap-3 rounded-2xl px-2 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted",
      )}
    >
      <span className="relative mt-0.5 shrink-0">
        <BotAvatar botId={meeting.bot.botId} className="size-10" />
        {(isWorking(meeting) || failed) && (
          <span
            className={cn(
              "absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-background ring-2 ring-background",
              failed ? "text-warning" : "text-muted-foreground",
            )}
          >
            {failed ? <TriangleAlertIcon className="size-3.5" /> : <Spinner className="size-3.5" />}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{meeting.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelative(meeting.createdAt, now)}
          </span>
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground",
            failed && "text-warning",
          )}
        >
          <Source className="size-3.5 shrink-0" aria-label={SOURCE_LABELS[meeting.source]} />
          <span className="truncate">
            {[showProject && meeting.projectName, meetingLine(meeting)].filter(Boolean).join(" · ")}
          </span>
        </span>
        {meeting.recap && (
          <span className="mt-1 block">
            <MiniStrip recap={meeting.recap} />
          </span>
        )}
      </span>
    </button>
  )
}

/** A meeting's project, as a full-width select. */
function ProjectSelect({
  id,
  projects,
  value,
  onChange,
}: {
  id: string
  projects: MeetingProject[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <Select
      value={value}
      items={projects.map((p) => ({ value: p.id, label: p.name }))}
      onValueChange={(next) => next && onChange(next)}
    >
      <SelectTrigger id={id} className="h-11 w-full">
        <FolderIcon className="text-muted-foreground" />
        <SelectValue className="flex-1 text-left" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The project a new meeting goes under: the one picked, else the first on offer. */
function usePickedProject() {
  const projects = useMeetingProjects()
  const [picked, setPicked] = useState<string>()
  const project = projects.find((p) => p.id === picked) ?? projects[0]
  return { projects, project, pick: setPicked }
}

/** A file's length from its metadata; unknown (0) when the browser can't read it. */
function audioLength(file: File) {
  return new Promise<number>((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    const done = (seconds: number) => {
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(seconds) ? seconds : 0)
    }
    audio.preload = "metadata"
    audio.onloadedmetadata = () => done(audio.duration)
    audio.onerror = () => done(0)
    audio.src = url
  })
}

const sizeText = (bytes: number) =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`

const RECORDING_TYPES = "audio/*,video/mp4,video/webm"
const TRANSCRIPT_TYPES = ".txt,.vtt,.srt,.md,text/plain,text/vtt,text/markdown"
/** Transcripts are text; anything bigger than this isn't one. */
const MAX_TRANSCRIPT_BYTES = 2_000_000

const isTranscript = (file: File) =>
  /\.(txt|vtt|srt|md)$/i.test(file.name) || file.type.startsWith("text/")

const baseName = (name: string) => name.replace(/\.[^.]+$/, "")

/** A recording or a transcript from the device, by its extension, and the project it's filed under. */
function Upload({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const go = useSwap()
  const bot = useMeetingBot()
  const { projects, project, pick } = usePickedProject()
  const [picked, setPicked] = useState<
    { file: File; seconds: number } | { file: File; text: string }
  >()
  const parsed = picked && "text" in picked ? parseTranscript(picked.text) : undefined

  const choose = async (file: File) => {
    if (!isTranscript(file)) {
      setPicked({ file, seconds: await audioLength(file) })
      return
    }
    if (file.size > MAX_TRANSCRIPT_BYTES) {
      toast.error("That file is too big for a transcript.")
      return
    }
    setPicked({ file, text: await file.text() })
  }

  const ready = picked && (!parsed || parsed.lines.length > 0)

  const add = () => {
    if (!project || !picked || !ready) return
    const title = baseName(picked.file.name)
    const meeting = parsed
      ? createMeeting({
          title,
          project,
          bot,
          source: "transcript",
          fileName: picked.file.name,
          duration: parsed.duration,
          transcript: parsed.lines,
        })
      : createMeeting({
          title,
          project,
          bot,
          source: "upload",
          fileName: picked.file.name,
          duration: "seconds" in picked ? picked.seconds : 0,
        })
    onOpenChange(false)
    go(`/meetings/${meeting.id}`)
  }

  const detail = !picked
    ? undefined
    : parsed
      ? parsed.lines.length
        ? [
            `${parsed.lines.length} ${parsed.lines.length === 1 ? "line" : "lines"}`,
            `${parsed.timed ? "" : "about "}${length(parsed.duration)}`,
          ].join(" · ")
        : "No lines found"
      : [
          "seconds" in picked && picked.seconds ? length(picked.seconds) : null,
          sizeText(picked.file.size),
        ]
          .filter(Boolean)
          .join(" · ")

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="md">
        <PopupHeader className="pb-2">
          <PopupTitle>Upload a meeting</PopupTitle>
        </PopupHeader>
        <form
          className="flex flex-col gap-5 px-6"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <Field>
            <FieldLabel htmlFor="meeting-file">Recording or transcript</FieldLabel>
            <Input
              id="meeting-file"
              type="file"
              accept={`${RECORDING_TYPES},${TRANSCRIPT_TYPES}`}
              className="h-11 cursor-pointer py-2 file:mr-3 file:cursor-pointer"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void choose(file)
              }}
            />
            {detail && <FieldDescription>{detail}</FieldDescription>}
          </Field>

          {project && (
            <Field>
              <FieldLabel htmlFor="meeting-project">Project</FieldLabel>
              <ProjectSelect
                id="meeting-project"
                projects={projects}
                value={project.id}
                onChange={pick}
              />
            </Field>
          )}

          <Button type="submit" size="lg" className="h-11 rounded-full" disabled={!ready}>
            Add
          </Button>
        </form>
      </PopupContent>
    </Popup>
  )
}

const defaultTitle = () =>
  `Meeting at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`

/** A level that moves while recording: a stand-in until the app hears the room. */
function useLevel(live: boolean) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!live || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = window.setInterval(() => setLevel(Math.random()), 180)
    return () => window.clearInterval(timer)
  }, [live])
  return live ? level : 0
}

/**
 * Recording a meeting, full screen: the bot listening, what it last heard, and moments marked as
 * they happen. Only mounted while it's open, so every recording starts fresh.
 */
function Recorder({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const bot = useMeetingBot()
  const { projects, project, pick } = usePickedProject()
  const [placeholder] = useState(defaultTitle)
  const [title, setTitle] = useState("")
  const [typed, setTyped] = useState("")
  const [writing, setWriting] = useState(false)
  const [marks, setMarks] = useState<Mark[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const level = useLevel(!paused)

  useEffect(() => {
    if (paused) return
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(timer)
  }, [paused])

  const leave = useCallback(() => {
    if (elapsed > 0) setConfirming(true)
    else onClose()
  }, [elapsed, onClose])
  useEffect(() => setBackGuard(() => (leave(), true)), [leave])

  const mark = (kind: MomentKind) => {
    setMarks((current) => [...current, { kind, at: elapsed }])
    toast(`${MOMENT_LOOK[kind].label} marked at ${clock(elapsed)}`)
  }

  const end = () => {
    if (!project) return
    const meeting = createMeeting({
      title: title.trim() || placeholder,
      project,
      bot,
      source: "recording",
      duration: elapsed,
      typed,
      marks,
    })
    onDone(meeting.id)
  }

  const heard = heardAt(elapsed)

  return (
    <FullscreenPopup
      open
      onOpenChange={(open) => !open && leave()}
      className="bg-radial-[at_50%_35%] from-primary/15 via-background via-60% to-background"
    >
      <Header
        className="bg-transparent backdrop-blur-none"
        leading={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 shrink-0 rounded-full bg-background/70"
            onClick={leave}
            aria-label="Discard recording"
          >
            <XIcon />
          </Button>
        }
        title={
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={placeholder}
            aria-label="Title"
            autoComplete="off"
            className="h-11 border-0 bg-transparent px-0 text-base font-semibold shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        }
        actions={
          project && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    className="h-11 max-w-36 shrink-0 rounded-full bg-background/70"
                    aria-label={`Project: ${project.name}`}
                  />
                }
              >
                <FolderIcon data-icon="inline-start" className="text-muted-foreground" />
                <span className="truncate">{project.name}</span>
                <ChevronDownIcon data-icon="inline-end" className="text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {projects.map((p) => (
                  <DropdownMenuItem key={p.id} className="min-h-11" onClick={() => pick(p.id)}>
                    <FolderIcon />
                    <span className="flex-1">{p.name}</span>
                    {p.id === project.id && <CheckIcon />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />

      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-4">
        <div className="relative flex size-52 items-center justify-center" aria-hidden>
          {[0, 1, 2].map((ring) => (
            <span
              key={ring}
              className="absolute inset-0 rounded-full border-2 border-primary transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none"
              style={{
                transform: `scale(${1 + ring * 0.24 + level * 0.06 * (ring + 1)})`,
                opacity: paused ? 0.06 : 0.2 - ring * 0.06,
              }}
            />
          ))}
          <Bot
            id={bot.botId}
            animate={!paused}
            className={cn(
              "size-36 drop-shadow-xl transition-[opacity,filter]",
              paused && "opacity-60 grayscale",
            )}
          />
        </div>

        <div className="flex flex-col items-center gap-1">
          <span className="flex items-center gap-2 text-sm font-semibold text-primary">
            <span
              className={cn(
                "size-2 rounded-full",
                paused ? "bg-muted-foreground" : "bg-destructive motion-safe:animate-pulse",
              )}
            />
            {paused ? <span className="text-muted-foreground">Paused</span> : "Recording"}
          </span>
          <span className="text-6xl font-semibold tracking-tight tabular-nums">
            {clock(elapsed)}
          </span>
        </div>

        <p className="min-h-20 max-w-md text-center" aria-live="polite">
          {heard.before && (
            <span className="mb-1 line-clamp-1 block text-sm text-muted-foreground/70">
              {heard.before}
            </span>
          )}
          <span className={cn("text-lg leading-snug", paused && "text-muted-foreground")}>
            {heard.line}
          </span>
        </p>
      </div>

      <div
        data-toast-above
        className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <div className="grid grid-cols-3 gap-3">
          {(["decision", "action", "open"] as MomentKind[]).map((kind) => {
            const count = marks.filter((m) => m.kind === kind).length
            return (
              <Button
                key={kind}
                type="button"
                variant="outline"
                onClick={() => mark(kind)}
                className="relative h-20 flex-col gap-1.5 rounded-3xl bg-card text-sm font-semibold shadow-sm active:scale-95 motion-reduce:transition-none"
              >
                <MomentIcon kind={kind} className="size-5 text-foreground" />
                {MOMENT_LOOK[kind].label}
                {count > 0 && (
                  <span
                    className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums"
                    aria-label={`${count} marked`}
                  >
                    {count}
                  </span>
                )}
              </Button>
            )
          })}
        </div>
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            size="icon-lg"
            className="size-14 rounded-full"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Resume" : "Pause"}
          >
            {paused ? <PlayIcon className="size-6" /> : <PauseIcon className="size-6" />}
          </Button>
          <Button
            size="lg"
            className="h-14 flex-1 rounded-full bg-foreground text-base text-background hover:bg-foreground/90"
            disabled={elapsed < 1 || !project}
            onClick={end}
          >
            <SquareIcon data-icon="inline-start" className="fill-current" />
            End meeting
          </Button>
          <Button
            variant="secondary"
            size="icon-lg"
            className="relative size-14 rounded-full"
            onClick={() => setWriting(true)}
            aria-label="Notes"
          >
            <NotebookPenIcon className="size-6" />
            {typed.trim() && (
              <span className="absolute top-3 right-3 size-2 rounded-full bg-primary" />
            )}
          </Button>
        </div>
      </div>

      <Popup open={writing} onOpenChange={setWriting}>
        <PopupContent size="md">
          <PopupHeader className="pb-2">
            <PopupTitle>Your notes</PopupTitle>
          </PopupHeader>
          <div className="flex flex-col gap-4 px-6">
            <Textarea
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-label="Your notes"
              autoFocus
              className="min-h-48 resize-none rounded-3xl px-4 py-3 text-base md:text-[15px]"
            />
            <Button size="lg" className="h-11 rounded-full" onClick={() => setWriting(false)}>
              Done
            </Button>
          </div>
        </PopupContent>
      </Popup>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this recording?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep recording</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onClose}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FullscreenPopup>
  )
}

const STEPS = ["Upload", "Transcribe", "Write", "Ready"]
// A transcript skips the upload and the transcription.
const TRANSCRIPT_STEPS = ["Transcript", "Write", "Ready"]

function stepOf(meeting: Meeting) {
  const step =
    meeting.stage === "uploading"
      ? 0
      : meeting.stage === "writing"
        ? 2
        : meeting.stage === "ready"
          ? 3
          : 1
  if (meeting.source !== "transcript") return step
  return meeting.stage === "ready" ? 2 : 1
}

/** Upload, Transcribe, Write, Ready, as dots joined by lines; a failed step is marked. */
function Steps({ meeting }: { meeting: Meeting }) {
  const at = stepOf(meeting)
  const steps = meeting.source === "transcript" ? TRANSCRIPT_STEPS : STEPS
  const failed = meeting.stage === "failed"
  return (
    <ol className="flex w-full items-center gap-2" aria-label="Progress">
      {steps.map((step, index) => (
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
                index === at &&
                  (failed
                    ? "bg-warning/15 text-warning ring-1 ring-warning"
                    : "bg-primary/15 text-primary ring-1 ring-primary"),
                index > at && "bg-muted",
              )}
            >
              {index < at ? <CheckIcon className="size-3" /> : index + 1}
            </span>
            <span className={cn(index !== at && "max-sm:sr-only")}>{step}</span>
          </span>
          {index < steps.length - 1 && (
            <span
              className={cn("h-0.5 flex-1 rounded-full", index < at ? "bg-primary" : "bg-border")}
            />
          )}
        </li>
      ))}
    </ol>
  )
}

/** One meeting: the bot at work on it, then its recap, timeline and topics. */
export function MeetingPage() {
  return (
    <Gate>
      <MeetingView />
    </Gate>
  )
}

function Gone() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
      This meeting is gone.
    </div>
  )
}

function MeetingView() {
  const { id = "" } = useParams()
  const meeting = useMeeting(id)
  const navigate = useNavigate()
  const { up } = useNav()
  const beside = Boolean(useMeetingsPane())
  const now = useNow()
  const scroller = useRef<HTMLDivElement>(null)
  const back = useCallback(() => up("/meetings"), [up])
  useEffect(() => setBackGuard(() => (back(), true)), [back])

  const said = meeting?.chat?.length ?? 0
  useEffect(() => {
    const node = scroller.current
    if (!said || !node) return
    node.scrollTo({
      top: node.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    })
  }, [said])

  if (!meeting) return <Gone />

  const open = (topic: Topic, at?: number) =>
    navigate(`/meetings/${meeting.id}/topics/${topic.id}${at === undefined ? "" : `?at=${at}`}`)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Header
          leading={beside ? null : <BackButton onClick={back} label="Back to Meetings" />}
          title={
            <h1 className="truncate text-base font-semibold tracking-tight">{meeting.title}</h1>
          }
          subtitle={[
            meeting.projectName,
            length(meeting.duration),
            formatRelative(meeting.createdAt, now),
          ].join(" · ")}
          actions={<MeetingMenu meeting={meeting} onRemoved={back} />}
        />
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 pt-2 pb-8">
          {meeting.stage === "ready" && meeting.recap ? (
            <RecapView meeting={meeting} recap={meeting.recap} onOpen={open} />
          ) : (
            <Working meeting={meeting} />
          )}
        </div>
      </div>
      {meeting.stage === "ready" && <AskBar meeting={meeting} />}
    </div>
  )
}

function MeetingMenu({ meeting, onRemoved }: { meeting: Meeting; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-lg"
              className="size-11 shrink-0 rounded-full"
              aria-label="Meeting options"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {meeting.recap && (
            <DropdownMenuItem
              className="min-h-11"
              onClick={() =>
                navigator.clipboard
                  .writeText(toMarkdown(meeting))
                  .then(() => toast("Recap copied"))
                  .catch(() => toast.error("Couldn't copy the recap."))
              }
            >
              <ClipboardCopyIcon />
              Copy recap
            </DropdownMenuItem>
          )}
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
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this meeting?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                removeMeeting(meeting.id)
                onRemoved()
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

/** The bot at work on a meeting while the host uploads, transcribes and writes it up. */
function Working({ meeting }: { meeting: Meeting }) {
  const { progress } = meeting
  const failed = meeting.stage === "failed"
  return (
    <>
      <div className="flex flex-col items-center gap-5 rounded-[2rem] bg-radial-[at_50%_30%] from-primary/12 to-transparent to-70% px-4 pt-8 pb-6">
        <span className="relative flex size-32 items-center justify-center" aria-hidden>
          {!failed && (
            <span className="absolute inset-0 rounded-full border-2 border-primary/20 motion-safe:animate-ping motion-safe:[animation-duration:2.4s]" />
          )}
          <Bot
            id={meeting.bot.botId}
            animate={!failed}
            className={cn("size-28 drop-shadow-lg", failed && "opacity-60 grayscale")}
          />
        </span>
        <p className="text-center text-lg font-semibold tracking-tight">
          {failed ? `${meeting.bot.name} got stuck` : meetingLine(meeting)}
        </p>
        <Steps meeting={meeting} />
        {!failed && progress && (
          <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </span>
        )}
      </div>
      {failed && (
        <Banner
          action={
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-full"
              onClick={() => retryMeeting(meeting)}
            >
              <RotateCcwIcon data-icon="inline-start" />
              Try again
            </Button>
          }
        >
          {meeting.error}
        </Banner>
      )}
      {meeting.typed && <Typed text={meeting.typed} />}
    </>
  )
}

/** What the user typed while recording, as they typed it. */
function Typed({ text }: { text: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-medium text-muted-foreground">Your notes</h2>
      <p className="rounded-3xl bg-muted px-4 py-3 whitespace-pre-wrap">{text}</p>
    </section>
  )
}

/** "3 decisions, 2 to do and 1 open." */
function tally(recap: Recap) {
  const count = (kind: MomentKind) => recap.moments.filter((m) => m.kind === kind).length
  const parts = [
    count("decision") && `${count("decision")} decision${count("decision") === 1 ? "" : "s"}`,
    count("action") && `${count("action")} to do`,
    count("open") && `${count("open")} left open`,
  ].filter(Boolean) as string[]
  if (!parts.length) return ""
  return `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`
}

function RecapView({
  meeting,
  recap,
  onOpen,
}: {
  meeting: Meeting
  recap: Recap
  onOpen: (topic: Topic, at?: number) => void
}) {
  const seek = (at: number) => onOpen(topicAt(recap, at), at)
  return (
    <>
      <div className="flex gap-3">
        <BotAvatar botId={meeting.bot.botId} />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-sm font-semibold">{meeting.bot.name}</p>
          <p className="text-[15px] leading-relaxed">
            {recap.lead} {tally(recap)}
          </p>
        </div>
      </div>

      <Timeline meeting={meeting} recap={recap} onOpen={onOpen} />

      <MomentsCard meeting={meeting} recap={recap} onSeek={seek} />

      <section className="flex flex-col gap-1">
        <h2 className="px-1 pb-1 text-sm font-medium text-muted-foreground">Topics</h2>
        {recap.topics.map((topic, index) => (
          <TopicRow
            key={topic.id}
            topic={topic}
            index={index}
            moments={recap.moments.filter(
              (m) => m.at !== undefined && topicAt(recap, m.at).id === topic.id,
            )}
            onOpen={() => onOpen(topic)}
          />
        ))}
      </section>

      {meeting.typed && <Typed text={meeting.typed} />}

      {meeting.chat?.length ? <Conversation meeting={meeting} /> : null}
    </>
  )
}

/** The meeting laid out in time: its topics as spans, its moments pinned where they happened. */
function Timeline({
  meeting,
  recap,
  onOpen,
}: {
  meeting: Meeting
  recap: Recap
  onOpen: (topic: Topic, at?: number) => void
}) {
  const total = Math.max(meeting.duration, recap.topics.at(-1)?.end ?? 0, 1)
  const placed = recap.moments.filter((m) => m.at !== undefined)
  return (
    <section className="rounded-3xl border bg-card px-4 pt-3 pb-3" aria-label="Timeline">
      <div className="relative h-12">
        {placed.map((moment) => (
          <button
            key={moment.id}
            type="button"
            onClick={() => onOpen(topicAt(recap, moment.at!), moment.at)}
            aria-label={`${moment.text}, at ${clock(moment.at!)}`}
            className="absolute top-0 flex size-6 -translate-x-1/2 items-center justify-center rounded-full after:absolute after:-inset-2.5 hover:bg-muted"
            style={{ left: `${(moment.at! / total) * 100}%` }}
          >
            <MomentIcon kind={moment.kind} className={cn("size-3.5", moment.marked && "size-4")} />
          </button>
        ))}
        <div className="absolute inset-x-0 bottom-0 flex h-5 gap-0.5">
          {recap.topics.map((topic, index) => (
            <button
              key={topic.id}
              type="button"
              onClick={() => onOpen(topic)}
              aria-label={topic.title}
              className={cn(
                "h-full rounded-md transition-opacity hover:opacity-80",
                tone(index).span,
              )}
              style={{ flexGrow: Math.max(1, topic.end - topic.start), flexBasis: 0 }}
            />
          ))}
        </div>
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>0:00</span>
        <span>{clock(total / 2)}</span>
        <span>{clock(total)}</span>
      </div>
    </section>
  )
}

/** A time a line cites, which opens its topic there. */
function Stamp({ at, onSeek }: { at: number; onSeek: (at: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSeek(at)}
      aria-label={`Play from ${clock(at)}`}
      className="relative ml-1.5 inline-flex h-6 items-center rounded-full bg-primary/10 px-2 align-middle text-xs font-medium text-primary tabular-nums transition-colors after:absolute after:-inset-x-1 after:-inset-y-2.5 hover:bg-primary/20 dark:bg-success/15 dark:text-success"
    >
      {clock(at)}
    </button>
  )
}

/** What was decided, what's to do (each can start a session) and what's left open. */
function MomentsCard({
  meeting,
  recap,
  onSeek,
}: {
  meeting: Meeting
  recap: Recap
  onSeek: (at: number) => void
}) {
  const kinds = (Object.keys(MOMENT_TITLES) as MomentKind[]).filter((kind) =>
    recap.moments.some((m) => m.kind === kind),
  )
  if (!kinds.length) return null
  return (
    <div className="divide-y overflow-hidden rounded-3xl border bg-card">
      {kinds.map((kind) => (
        <section key={kind} className="flex flex-col gap-2 px-4 py-3.5">
          <h2
            className={cn(
              "flex items-center gap-1.5 text-xs font-bold tracking-wide uppercase",
              MOMENT_LOOK[kind].color,
            )}
          >
            <MomentIcon kind={kind} className="size-3.5" />
            {MOMENT_TITLES[kind]}
          </h2>
          <ul className="flex flex-col gap-2">
            {recap.moments
              .filter((m) => m.kind === kind)
              .map((moment) =>
                kind === "action" ? (
                  <ActionRow
                    key={moment.id}
                    meeting={meeting}
                    moment={moment}
                    started={meeting.started?.includes(moment.id) ?? false}
                    onSeek={onSeek}
                  />
                ) : (
                  <li key={moment.id} className="leading-relaxed">
                    {moment.text}
                    {moment.at !== undefined && <Stamp at={moment.at} onSeek={onSeek} />}
                    {moment.marked && <Marked />}
                  </li>
                ),
              )}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Marked() {
  return (
    <span className="ml-1.5 inline-flex h-6 items-center rounded-full bg-muted px-2 align-middle text-xs font-medium text-muted-foreground">
      You marked
    </span>
  )
}

function ActionRow({
  meeting,
  moment,
  started,
  onSeek,
}: {
  meeting: Meeting
  moment: Moment
  started: boolean
  onSeek: (at: number) => void
}) {
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-muted/70 py-2.5 pr-2.5 pl-3.5">
      <span className="min-w-0 flex-1">
        <span className="block leading-snug font-medium">{moment.text}</span>
        <span className="mt-0.5 flex flex-wrap items-center text-xs text-muted-foreground">
          {[moment.owner, moment.marked && "You marked"].filter(Boolean).join(" · ")}
          {moment.at !== undefined && <Stamp at={moment.at} onSeek={onSeek} />}
        </span>
      </span>
      {started ? (
        <span className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-sm font-medium text-primary dark:text-success">
          <CheckIcon className="size-4" />
          Started
        </span>
      ) : (
        <Button
          size="sm"
          className="h-9 shrink-0 rounded-full"
          aria-label={`Start a session: ${moment.text}`}
          onClick={() => {
            startAction(meeting.id, moment.id)
            toast(`Started a session in ${meeting.projectName}`)
          }}
        >
          <GitBranchIcon data-icon="inline-start" />
          Start
        </Button>
      )}
    </li>
  )
}

function TopicRow({
  topic,
  index,
  moments,
  onOpen,
}: {
  topic: Topic
  index: number
  moments: Moment[]
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full gap-3 rounded-3xl px-3 py-3 text-left transition-colors hover:bg-muted"
    >
      <span className={cn("w-1.5 shrink-0 rounded-full", tone(index).dot)} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 font-semibold">{topic.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {clock(topic.start)} · {length(topic.end - topic.start)}
          </span>
        </span>
        <span className="text-sm leading-relaxed text-muted-foreground">{topic.summary}</span>
        {moments.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1.5">
            {moments.map((m) => (
              <span
                key={m.id}
                className="inline-flex h-6 max-w-full items-center gap-1 rounded-lg bg-muted px-2 text-xs font-medium"
              >
                <MomentIcon kind={m.kind} className="size-3" />
                <span className="truncate">{m.text}</span>
              </span>
            ))}
          </span>
        )}
      </span>
      <ChevronRightIcon className="mt-0.5 size-4 shrink-0 self-center text-muted-foreground" />
    </button>
  )
}

/** Questions asked about the meeting and the bot's answers. */
function Conversation({ meeting }: { meeting: Meeting }) {
  const chat = meeting.chat ?? []
  const waiting = chat.at(-1)?.from === "user"
  return (
    <section className="flex flex-col gap-4 pt-2" aria-label="Questions">
      {chat.map((line) =>
        line.from === "user" ? (
          <p
            key={line.id}
            className="max-w-[85%] self-end rounded-3xl rounded-br-lg bg-primary px-4 py-2.5 text-primary-foreground"
          >
            {line.text}
          </p>
        ) : (
          <div key={line.id} className="flex gap-3">
            <BotAvatar botId={meeting.bot.botId} />
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-sm font-semibold">{meeting.bot.name}</p>
              <p className="leading-relaxed whitespace-pre-wrap">{line.text}</p>
            </div>
          </div>
        ),
      )}
      {waiting && (
        <div className="flex gap-3">
          <BotAvatar botId={meeting.bot.botId} />
          <p className="pt-2 text-muted-foreground">Thinking…</p>
        </div>
      )}
    </section>
  )
}

const PROMPTS = [
  { icon: MailIcon, text: "Write the follow-up" },
  { icon: DiamondIcon, text: "What did we decide?" },
  { icon: FlagIcon, text: "What's still open?" },
]

/** Asks the bot about the meeting, from a suggestion or in your own words. */
function AskBar({ meeting }: { meeting: Meeting }) {
  const [text, setText] = useState("")
  const busy = meeting.chat?.at(-1)?.from === "user"
  const ask = (question: string) => {
    if (!question.trim() || busy) return
    setText("")
    void askMeeting(meeting.id, question.trim())
  }
  return (
    <div
      data-toast-above
      className="border-t bg-background/90 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur"
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-2.5 px-4">
        {!meeting.chat?.length && (
          <div className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4">
            {PROMPTS.map(({ icon: Icon, text: prompt }) => (
              <Button
                key={prompt}
                variant="outline"
                className="h-9 shrink-0 rounded-full"
                onClick={() => ask(prompt)}
              >
                <Icon data-icon="inline-start" className="text-primary" />
                {prompt}
              </Button>
            ))}
          </div>
        )}
        <form
          className="flex items-center gap-2 rounded-full border bg-card py-1.5 pr-1.5 pl-1.5 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault()
            ask(text)
          }}
        >
          <BotAvatar botId={meeting.bot.botId} />
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={`Ask ${meeting.bot.name} about this meeting`}
            aria-label="Ask about this meeting"
            className="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-[15px]"
          />
          <Button
            type="submit"
            size="icon-lg"
            className="size-10 shrink-0 rounded-full"
            disabled={!text.trim() || busy}
            aria-label="Ask"
          >
            {busy ? <SparklesIcon className="motion-safe:animate-pulse" /> : <ArrowUpIcon />}
          </Button>
        </form>
      </div>
    </div>
  )
}

/** A topic of a meeting: its summary and quote, and its transcript following the playback. */
export function TopicPage() {
  return (
    <Gate>
      <TopicScreen />
    </Gate>
  )
}

function TopicScreen() {
  const { id = "", topic: topicId = "" } = useParams()
  const meeting = useMeeting(id)
  const topic = meeting?.recap?.topics.find((t) => t.id === topicId)
  if (!meeting?.recap || !topic) return <Gone />
  // A fresh player for each topic.
  return <TopicView key={topic.id} meeting={meeting} recap={meeting.recap} topic={topic} />
}

const SPEEDS = [1, 1.5, 2]

function TopicView({ meeting, recap, topic }: { meeting: Meeting; recap: Recap; topic: Topic }) {
  const navigate = useNavigate()
  const { up } = useNav()
  const [params] = useSearchParams()
  const from = params.get("at")
  const [position, setPosition] = useState(() => (from === null ? topic.start : Number(from)))
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [tab, setTab] = useState(from === null ? "summary" : "transcript")
  const rows = useRef(new Map<string, HTMLLIElement>())
  const back = useCallback(() => up(`/meetings/${meeting.id}`), [up, meeting.id])
  useEffect(() => setBackGuard(() => (back(), true)), [back])

  const index = recap.topics.indexOf(topic)
  const next = recap.topics[index + 1]
  const running = playing && position < topic.end
  const lines = meeting.transcript.filter((l) => l.at >= topic.start && l.at < topic.end)
  const current = lines.findLast((l) => l.at <= position)
  const inTopic = recap.moments.filter(
    (m) => m.at !== undefined && m.at >= topic.start && m.at < topic.end,
  )

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(
      () => setPosition((p) => Math.min(topic.end, p + 0.25 * speed)),
      250,
    )
    return () => window.clearInterval(timer)
  }, [running, speed, topic.end])

  const currentId = current?.id
  useEffect(() => {
    if (!currentId || tab !== "transcript") return
    const frame = requestAnimationFrame(() =>
      rows.current.get(currentId)?.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      }),
    )
    return () => cancelAnimationFrame(frame)
  }, [currentId, tab])

  const seek = (at: number) => {
    setPosition(at)
    setTab("transcript")
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Header
          leading={<BackButton onClick={back} label={`Back to ${meeting.title}`} />}
          title={<h1 className="truncate text-base font-semibold tracking-tight">{topic.title}</h1>}
          subtitle={`Topic ${index + 1} of ${recap.topics.length} · ${clock(topic.start)} to ${clock(topic.end)}`}
        />
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-8">
          <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
            <TabsList className="sticky top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] z-[5] -mx-4 w-auto bg-background px-4">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="flex flex-col gap-5 pt-5">
              <p className="text-[17px] leading-relaxed">{topic.summary}</p>
              {topic.quote && (
                <button
                  type="button"
                  onClick={() => seek(topic.quote!.at)}
                  className="flex flex-col gap-1 border-l-[3px] border-merged py-0.5 pl-4 text-left"
                >
                  <span className="text-lg leading-snug">“{topic.quote.text}”</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {clock(topic.quote.at)}
                  </span>
                </button>
              )}
              {inTopic.length > 0 && (
                <ul className="flex flex-col gap-2.5">
                  {inTopic.map((m) => (
                    <li key={m.id} className="flex gap-2.5 leading-relaxed">
                      <MomentIcon kind={m.kind} className="mt-1" />
                      <span className="min-w-0">
                        {m.text}
                        <Stamp at={m.at!} onSeek={seek} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="transcript" className="pt-3">
              <ol className="flex flex-col">
                {lines.map((line) => (
                  <li
                    key={line.id}
                    ref={(node) => {
                      if (node) rows.current.set(line.id, node)
                      else rows.current.delete(line.id)
                    }}
                    className={cn(
                      "-mx-1 rounded-2xl transition-colors",
                      line.id === current?.id && "bg-primary/10",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setPosition(line.at)}
                      className="flex w-full gap-4 px-3 py-2.5 text-left"
                    >
                      <span
                        className={cn(
                          "w-12 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums",
                          line.id === current?.id && "font-semibold text-primary dark:text-success",
                        )}
                      >
                        {clock(line.at)}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 leading-relaxed",
                          line.id !== current?.id && "text-muted-foreground",
                        )}
                      >
                        {line.text}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </TabsContent>
          </Tabs>
          {next && (
            <Button
              variant="outline"
              className="mt-8 h-12 justify-between rounded-full px-5"
              onClick={() =>
                navigate(`/meetings/${meeting.id}/topics/${next.id}`, {
                  replace: true,
                  state: { quiet: true },
                })
              }
            >
              <span className="truncate">Next: {next.title}</span>
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          )}
        </div>
      </div>

      <div
        data-toast-above
        className="pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        aria-label="Player"
      >
        <div className="mx-auto max-w-2xl px-4">
          <div className="flex flex-col gap-2 rounded-3xl border bg-card px-3 py-2.5 shadow-lg">
            <div className="flex items-center gap-3">
              <Button
                size="icon-lg"
                className="size-11 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90"
                aria-label={running ? "Pause" : "Play"}
                onClick={() => {
                  if (position >= topic.end) setPosition(topic.start)
                  setPlaying(!running)
                }}
              >
                {running ? (
                  <PauseIcon className="fill-current" />
                ) : (
                  <PlayIcon className="ml-0.5 fill-current" />
                )}
              </Button>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{topic.title}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {clock(position)} / {clock(meeting.duration)}
                </span>
              </span>
              <Button
                variant="secondary"
                className="h-11 min-w-14 shrink-0 rounded-full tabular-nums"
                aria-label={`Speed ${speed}×`}
                onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
              >
                {speed}×
              </Button>
            </div>
            <span className="flex h-1 gap-0.5" aria-hidden>
              {recap.topics.map((t, i) => (
                <span
                  key={t.id}
                  className="relative overflow-hidden rounded-full bg-muted"
                  style={{ flexGrow: Math.max(1, t.end - t.start), flexBasis: 0 }}
                >
                  <span
                    className={cn("absolute inset-y-0 left-0", tone(i).dot)}
                    style={{
                      width: `${Math.min(100, Math.max(0, ((position - t.start) / Math.max(1, t.end - t.start)) * 100))}%`,
                    }}
                  />
                </span>
              ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
