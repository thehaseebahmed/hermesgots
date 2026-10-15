import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import {
  ArrowLeftIcon,
  CheckIcon,
  ClipboardCopyIcon,
  EllipsisIcon,
  FileAudioIcon,
  FolderIcon,
  MenuIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
  clock,
  createMeeting,
  isWorking,
  length,
  meetingLine,
  removeMeeting,
  retryMeeting,
  toMarkdown,
  useMeeting,
  useMeetingProjects,
  useMeetings,
  useMeetingsEnabled,
  type Meeting,
  type MeetingProject,
  type NoteItem,
} from "@/lib/meetings"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
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
}: {
  leading: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
      <div className="mx-auto flex max-w-2xl items-center gap-3">
        {leading}
        <div className="flex min-w-0 flex-1 flex-col">
          {title}
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {actions}
      </div>
    </header>
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

function MeetingsList() {
  const openDrawer = useOpenDrawer()
  const navigate = useNavigate()
  const meetings = useMeetings()
  const [adding, setAdding] = useState(false)
  // A fresh form each time it opens.
  const [form, setForm] = useState(0)
  const now = useNow()

  // Each project once, in the order of its newest meeting.
  const projects = [...new Map(meetings.map((m) => [m.projectId, m.projectName])).entries()]

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

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="grid grid-cols-2 gap-3">
          <Button
            size="lg"
            className="h-14 rounded-3xl text-base"
            onClick={() => navigate("/meetings/record")}
          >
            <MicIcon data-icon="inline-start" />
            Record
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="h-14 rounded-3xl text-base"
            onClick={() => {
              setForm((n) => n + 1)
              setAdding(true)
            }}
          >
            <UploadIcon data-icon="inline-start" />
            Add recording
          </Button>
        </div>

        {meetings.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No meetings yet.</p>
        )}

        {projects.map(([projectId, projectName]) => {
          const rows = meetings.filter((m) => m.projectId === projectId)
          return (
            <section key={projectId} className="flex flex-col gap-2">
              <h2 className="flex items-center gap-2 px-1 text-sm font-medium text-muted-foreground">
                {projectName}
                <span className="rounded-full bg-muted px-1.5 text-xs leading-5 font-semibold tabular-nums">
                  {rows.length}
                </span>
              </h2>
              <ul className="flex flex-col gap-2">
                {rows.map((meeting) => (
                  <li key={meeting.id}>
                    <MeetingRow
                      meeting={meeting}
                      now={now}
                      onOpen={() => navigate(`/meetings/${meeting.id}`)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>

      <AddRecording key={form} open={adding} onOpenChange={setAdding} />
    </div>
  )
}

function MeetingRow({
  meeting,
  now,
  onOpen,
}: {
  meeting: Meeting
  now: number
  onOpen: () => void
}) {
  const failed = meeting.stage === "failed"
  const Icon = meeting.source === "recording" ? MicIcon : FileAudioIcon
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-16 w-full items-center gap-3 rounded-3xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-2xl",
          failed ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
        )}
      >
        {isWorking(meeting) ? (
          <Spinner className="size-5" />
        ) : failed ? (
          <TriangleAlertIcon className="size-5" />
        ) : (
          <Icon className="size-5" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{meeting.title}</span>
        <span className={cn("truncate text-sm text-muted-foreground", failed && "text-warning")}>
          {meetingLine(meeting)}
        </span>
      </span>
      <span className="shrink-0 self-start pt-0.5 text-xs text-muted-foreground">
        {formatRelative(meeting.createdAt, now)}
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

/** An audio file from the device, its title and the project it's filed under. */
function AddRecording({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const { projects, project, pick } = usePickedProject()
  const [file, setFile] = useState<{ file: File; seconds: number }>()
  const [title, setTitle] = useState("")

  const choose = async (picked: File | undefined) => {
    if (!picked) return
    const seconds = await audioLength(picked)
    setFile({ file: picked, seconds })
    setTitle((current) => current || picked.name.replace(/\.[^.]+$/, ""))
  }

  const add = () => {
    if (!file || !project) return
    const meeting = createMeeting({
      title: title.trim() || file.file.name,
      project,
      source: "upload",
      fileName: file.file.name,
      duration: file.seconds,
    })
    onOpenChange(false)
    navigate(`/meetings/${meeting.id}`)
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="md">
        <PopupHeader className="pb-2">
          <PopupTitle>Add recording</PopupTitle>
        </PopupHeader>
        <form
          className="flex flex-col gap-5 px-6"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <input
            ref={input}
            type="file"
            accept="audio/*,video/mp4,video/webm"
            className="hidden"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => input.current?.click()}
            className={cn(
              "flex min-h-20 items-center gap-3 rounded-3xl border px-4 py-3 text-left transition-colors hover:bg-muted",
              !file && "border-dashed",
            )}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <FileAudioIcon className="size-5" />
            </span>
            {file ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{file.file.name}</span>
                <span className="text-sm text-muted-foreground">
                  {[file.seconds ? length(file.seconds) : null, sizeText(file.file.size)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            ) : (
              <span className="flex-1 font-medium">Choose an audio file</span>
            )}
          </button>

          <Field>
            <FieldLabel htmlFor="meeting-title">Title</FieldLabel>
            <Input
              id="meeting-title"
              className="h-11"
              autoComplete="off"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
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

          <Button type="submit" size="lg" className="h-11 rounded-full" disabled={!file}>
            Add
          </Button>
        </form>
      </PopupContent>
    </Popup>
  )
}

const BARS = 24

/** A level meter that moves while recording: a stand-in until the app hears the room. */
function Level({ live }: { live: boolean }) {
  const [levels, setLevels] = useState(() => Array<number>(BARS).fill(0.1))
  useEffect(() => {
    if (!live || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = window.setInterval(
      () => setLevels((current) => [...current.slice(1), 0.15 + Math.random() * 0.85]),
      120,
    )
    return () => window.clearInterval(timer)
  }, [live])
  return (
    <div className="flex h-16 items-center justify-center gap-1" aria-hidden>
      {levels.map((level, index) => (
        <span
          key={index}
          className={cn(
            "w-1.5 rounded-full transition-[height] duration-100",
            live ? "bg-primary" : "bg-muted-foreground/40",
          )}
          style={{ height: `${Math.round((live ? level : 0.1) * 100)}%` }}
        />
      ))}
    </div>
  )
}

const defaultTitle = () =>
  `Meeting at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`

/** Recording a meeting: the time, a level meter, notes typed as it goes, and Pause and Stop. */
export function RecordPage() {
  return (
    <Gate>
      <Recorder />
    </Gate>
  )
}

function Recorder() {
  const navigate = useNavigate()
  const { up } = useNav()
  const { projects, project, pick } = usePickedProject()
  const [placeholder] = useState(defaultTitle)
  const [title, setTitle] = useState("")
  const [typed, setTyped] = useState("")
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (paused) return
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(timer)
  }, [paused])

  const leave = useCallback(() => {
    if (elapsed > 0) setConfirming(true)
    else up("/meetings")
  }, [elapsed, up])
  useEffect(() => setBackGuard(() => (leave(), true)), [leave])

  const stop = () => {
    if (!project) return
    const meeting = createMeeting({
      title: title.trim() || placeholder,
      project,
      source: "recording",
      duration: elapsed,
      typed,
    })
    navigate(`/meetings/${meeting.id}`, { replace: true })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        leading={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 shrink-0 rounded-full"
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
      />

      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-5 px-4 pt-2">
        {project && (
          <ProjectSelect
            id="recording-project"
            projects={projects}
            value={project.id}
            onChange={pick}
          />
        )}

        <div className="flex flex-col items-center gap-2 py-2">
          <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <span
              className={cn(
                "size-2.5 rounded-full",
                paused ? "bg-muted-foreground" : "bg-destructive motion-safe:animate-pulse",
              )}
            />
            {paused ? "Paused" : "Recording"}
          </span>
          <span className="text-5xl font-semibold tracking-tight tabular-nums">
            {clock(elapsed)}
          </span>
          <Level live={!paused} />
        </div>

        <Textarea
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Notes"
          aria-label="Notes"
          className="min-h-32 flex-1 resize-none rounded-3xl px-4 py-3 text-base md:text-[15px]"
        />
      </div>

      <div
        data-toast-above
        className="mx-auto grid w-full max-w-2xl grid-cols-2 gap-3 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <Button
          variant="outline"
          size="lg"
          className="h-14 rounded-full text-base"
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="destructive"
          size="lg"
          className="h-14 rounded-full text-base"
          disabled={elapsed < 1 || !project}
          onClick={stop}
        >
          <SquareIcon data-icon="inline-start" className="fill-current" />
          Stop
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this recording?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep recording</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => up("/meetings")}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const STEPS = ["Upload", "Transcribe", "Write", "Ready"]

function stepOf(meeting: Meeting) {
  if (meeting.stage === "uploading") return 0
  if (meeting.stage === "writing") return 2
  if (meeting.stage === "ready") return 3
  return 1
}

/** Upload, Transcribe, Write, Ready, as dots joined by lines; a failed step is marked. */
function Steps({ meeting }: { meeting: Meeting }) {
  const at = stepOf(meeting)
  const failed = meeting.stage === "failed"
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

/** One meeting: its progress while the host works, then its notes and transcript. */
export function MeetingPage() {
  return (
    <Gate>
      <MeetingView />
    </Gate>
  )
}

function MeetingView() {
  const { id = "" } = useParams()
  const meeting = useMeeting(id)
  const { up } = useNav()
  const now = useNow()
  const back = useCallback(() => up("/meetings"), [up])
  useEffect(() => setBackGuard(() => (back(), true)), [back])

  if (!meeting)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        This meeting is gone.
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Header
        leading={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 shrink-0 rounded-full"
            onClick={back}
            aria-label="Back to Meetings"
          >
            <ArrowLeftIcon />
          </Button>
        }
        title={<h1 className="truncate text-base font-semibold tracking-tight">{meeting.title}</h1>}
        subtitle={[
          meeting.projectName,
          length(meeting.duration),
          formatRelative(meeting.createdAt, now),
        ].join(" · ")}
        actions={<MeetingMenu meeting={meeting} onRemoved={back} />}
      />
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {meeting.stage === "ready" ? (
          <MeetingTabs meeting={meeting} />
        ) : (
          <Progress meeting={meeting} />
        )}
      </div>
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
          {meeting.note && (
            <DropdownMenuItem
              className="min-h-11"
              onClick={() =>
                navigator.clipboard
                  .writeText(toMarkdown(meeting))
                  .then(() => toast("Notes copied"))
                  .catch(() => toast.error("Couldn't copy the notes."))
              }
            >
              <ClipboardCopyIcon />
              Copy notes
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

/** Where the host is with a meeting, or the step that failed and Try again. */
function Progress({ meeting }: { meeting: Meeting }) {
  const { progress } = meeting
  return (
    <>
      <Steps meeting={meeting} />
      {meeting.stage === "failed" ? (
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
      ) : (
        <div className="flex flex-col gap-3 rounded-3xl border bg-card px-4 py-4">
          <span className="flex items-center gap-3 font-medium">
            <Spinner className="size-5 text-muted-foreground" />
            {meetingLine(meeting)}
          </span>
          {progress && (
            <span className="h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </span>
          )}
        </div>
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

type Tab = "notes" | "transcript" | "typed"

function MeetingTabs({ meeting }: { meeting: Meeting }) {
  const [tab, setTab] = useState<Tab>("notes")
  const [focus, setFocus] = useState<{ line: string; at: number }>()

  // A timestamp opens the transcript at the line it cites: the last one said at or before it.
  const jump = (at: number) => {
    const line = meeting.transcript.findLast((l) => l.at <= at) ?? meeting.transcript[0]
    if (!line) return
    setFocus({ line: line.id, at: Date.now() })
    setTab("transcript")
  }

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
      <TabsList className="sticky top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] z-[5] -mx-4 w-auto bg-background px-4">
        <TabsTrigger value="notes">Notes</TabsTrigger>
        <TabsTrigger value="transcript">Transcript</TabsTrigger>
        {meeting.typed && <TabsTrigger value="typed">Your notes</TabsTrigger>}
      </TabsList>
      <TabsContent value="notes" className="pt-5">
        {meeting.note && <Notes meeting={meeting} onJump={jump} />}
      </TabsContent>
      <TabsContent value="transcript" className="pt-3">
        <Transcript meeting={meeting} focus={focus} />
      </TabsContent>
      {meeting.typed && (
        <TabsContent value="typed" className="pt-5">
          <p className="whitespace-pre-wrap">{meeting.typed}</p>
        </TabsContent>
      )}
    </Tabs>
  )
}

function Stamp({ item, onJump }: { item: NoteItem; onJump: (at: number) => void }) {
  if (item.at === undefined)
    return (
      <span className="ml-1.5 inline-flex h-6 items-center rounded-full bg-warning/15 px-2 align-middle text-xs font-medium text-warning">
        No timestamp
      </span>
    )
  const at = item.at
  return (
    <button
      type="button"
      onClick={() => onJump(at)}
      aria-label={`Open the transcript at ${clock(at)}`}
      className="relative ml-1.5 inline-flex h-6 items-center rounded-full bg-primary/10 px-2 align-middle text-xs font-medium text-primary tabular-nums transition-colors after:absolute after:-inset-x-1 after:-inset-y-2.5 hover:bg-primary/20"
    >
      {clock(at)}
    </button>
  )
}

function Notes({ meeting, onJump }: { meeting: Meeting; onJump: (at: number) => void }) {
  const note = meeting.note!
  return (
    <div className="flex flex-col gap-6">
      <p className="text-[15px] leading-relaxed">{note.summary}</p>
      {note.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-2">
          <h2 className="text-base font-semibold tracking-tight">{section.title}</h2>
          {section.items.length ? (
            <ul className="flex flex-col gap-2.5">
              {section.items.map((item, index) => (
                <li key={index} className="flex gap-3 leading-relaxed">
                  {section.id === "actions" ? (
                    <span className="mt-1 size-4 shrink-0 rounded border-2 border-muted-foreground/50" />
                  ) : (
                    <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                  )}
                  <span className="min-w-0">
                    {item.text}
                    <Stamp item={item} onJump={onJump} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">None recorded.</p>
          )}
        </section>
      ))}
    </div>
  )
}

/** The transcript, line by line; a line a timestamp opened is scrolled to and lit up. */
function Transcript({
  meeting,
  focus,
}: {
  meeting: Meeting
  focus?: { line: string; at: number }
}) {
  const lines = useRef(new Map<string, HTMLLIElement>())

  useEffect(() => {
    if (!focus) return
    const row = lines.current.get(focus.line)
    // The panel slides in first; scroll once it's laid out.
    const frame = requestAnimationFrame(() =>
      row?.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      }),
    )
    return () => cancelAnimationFrame(frame)
  }, [focus])

  return (
    <ol className="flex flex-col">
      {meeting.transcript.map((line) => (
        <li
          key={line.id}
          ref={(node) => {
            if (node) lines.current.set(line.id, node)
            else lines.current.delete(line.id)
          }}
          className="relative flex scroll-mt-32 gap-4 rounded-2xl px-3 py-2.5"
        >
          {focus?.line === line.id && (
            // Keyed by the jump, so opening the same line again lights it up again.
            <span
              key={focus.at}
              aria-hidden
              className="pointer-events-none absolute inset-0 animate-out rounded-2xl bg-primary/10 duration-2500 ease-in fade-out-0 fill-mode-forwards"
            />
          )}
          <span className="w-12 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
            {clock(line.at)}
          </span>
          <span className="min-w-0 leading-relaxed">{line.text}</span>
        </li>
      ))}
    </ol>
  )
}
