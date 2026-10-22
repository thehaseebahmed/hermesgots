import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router"
import {
  ArrowLeftIcon,
  AudioLinesIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardCopyIcon,
  DiamondIcon,
  EllipsisIcon,
  FileAudioIcon,
  FileTextIcon,
  FlagIcon,
  FolderIcon,
  ListIcon,
  MenuIcon,
  MicIcon,
  PauseIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { ItemGroup, ItemRow, ItemSearch } from "@/components/item-list"
import { itemGroups } from "@/lib/item-groups"
import { FullscreenPopup, Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { canRecord } from "@/lib/dictation"
import { formatRelative } from "@/lib/format"
import { useMeetingRecorder, type Recorded } from "@/lib/meeting-recorder"
import {
  addRecording,
  addTranscript,
  clock,
  isFailed,
  isWorking,
  length,
  matchesMeeting,
  meetingLine,
  momentsOf,
  NOTE_SECTIONS,
  parseTranscript,
  removeMeeting,
  retryMeeting,
  toMarkdown,
  topicAt,
  useMeeting,
  useMeetingBot,
  useMeetingBots,
  useMeetingProjects,
  useMeetings,
  useMeetingsEnabled,
  useNoAudio,
  type Listed,
  type Meeting,
  type MeetingProject,
  type Moment,
  type MomentKind,
  type NoteItem,
  type Notes,
  type NoteSection,
  type Topic,
} from "@/lib/meetings"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import {
  itemToOpen,
  useMeetingsPane,
  useRememberOpened,
  type FeaturePane as PaneState,
} from "@/lib/pane"
import { createSignal } from "@/lib/store"
import { useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

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
      <MeetingsIndex />
    </Gate>
  )
}

/** Asks the list to open the New meeting sheet, from the empty pane beside it. */
const newMeetingAsked = createSignal()

/**
 * Beside the list (see `useMeetingsPane`) this screen is the meeting pane: the meeting opened
 * last, else the top one, else a way to make the first.
 */
function MeetingsIndex() {
  const pane = useMeetingsPane()
  const { meetings } = useMeetings()
  const now = useNow()
  if (!pane) return <MeetingsList />
  const ids = meetingGroups(meetings, now).flatMap((g) => g.items.map((m) => m.id))
  const open = itemToOpen("meetings", ids)
  if (open) return <Navigate to={`/meetings/${open}`} replace />
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
        <AudioLinesIcon className="size-8" aria-hidden />
      </span>
      <h2 className="text-lg font-semibold tracking-tight">No meetings yet</h2>
      <Button size="lg" className="h-12 rounded-full px-5" onClick={() => newMeetingAsked.notify()}>
        <PlusIcon /> New meeting
      </Button>
    </div>
  )
}

/** The list kept on screen beside the open meeting (see `useMeetingsPane`). */
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
  const { meetings, loaded, unsupported } = useMeetings()
  const [adding, setAdding] = useState(false)
  // A fresh form each time it opens.
  const [form, setForm] = useState(0)
  const [query, setQuery] = useState("")
  const [project, setProject] = useState<string>()
  const now = useNow()

  // Each project once, in the order of its newest meeting.
  const projects = [
    ...new Map(
      meetings.filter((m) => m.projectId).map((m) => [m.projectId!, m.projectName ?? "Project"]),
    ).entries(),
  ]
  const shown = meetings.filter(
    (m) => (!project || m.projectId === project) && matchesMeeting(m, query),
  )
  const groups = meetingGroups(shown, now)
  const filtering = Boolean(query.trim() || project)
  const reason = Object.values(unsupported)[0]

  useEffect(
    () =>
      newMeetingAsked.subscribe(() => {
        setForm((n) => n + 1)
        setAdding(true)
      }),
    [],
  )

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
        {reason && <Banner>{reason}</Banner>}
        {meetings.length > 0 && (
          <div className="flex flex-col gap-3">
            <ItemSearch value={query} onChange={setQuery} label="Search meetings" />
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

        {meetings.length === 0 && loaded && !reason && (
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
          <ItemGroup key={group.key} group={group}>
            {group.items.map((meeting) => (
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
          </ItemGroup>
        ))}
      </div>

      <div className="pointer-events-none sticky bottom-0 mt-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-2xl justify-end">
          <Button
            data-toast-above
            size="lg"
            className="pointer-events-auto h-12 rounded-full px-5 shadow-lg"
            onClick={() => {
              setForm((n) => n + 1)
              setAdding(true)
            }}
          >
            <PlusIcon /> New meeting
          </Button>
        </div>
      </div>
      <NewMeeting key={form} open={adding} onOpenChange={setAdding} />
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

/** Meetings by what they need (a failed one waits on you), then by when they happened. */
function meetingGroups(meetings: Listed[], now: number) {
  return itemGroups(
    meetings,
    (m) => (isFailed(m) ? "waiting" : isWorking(m) ? "working" : undefined),
    (m) => m.createdAt,
    now,
  )
}

const SOURCE_ICONS = { upload: FileAudioIcon, transcript: FileTextIcon }
const SOURCE_LABELS = { upload: "Uploaded recording", transcript: "Transcript" }

function MeetingRow({
  meeting,
  now,
  showProject,
  selected,
  onOpen,
}: {
  meeting: Listed
  now: number
  showProject: boolean
  selected: boolean
  onOpen: () => void
}) {
  const failed = isFailed(meeting)
  const Source = SOURCE_ICONS[meeting.source]
  return (
    <ItemRow
      icon={<AudioLinesIcon aria-hidden />}
      waiting={failed}
      botId={meeting.bot.botId}
      title={meeting.title}
      when={formatRelative(meeting.createdAt, now)}
      warn={failed}
      line={
        <>
          <Source className="size-3.5 shrink-0" aria-label={SOURCE_LABELS[meeting.source]} />
          <span className="truncate">
            {[showProject && meeting.projectName, meetingLine(meeting)].filter(Boolean).join(" · ")}
          </span>
        </>
      }
      selected={selected}
      onOpen={onOpen}
    />
  )
}

const NO_PROJECT = "none"

/** A meeting's project, as a full-width select; a meeting needn't have one. */
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
      items={[
        { value: NO_PROJECT, label: "No project" },
        ...projects.map((p) => ({ value: p.id, label: p.name })),
      ]}
      onValueChange={(next) => next && onChange(next)}
    >
      <SelectTrigger id={id} className="h-11 w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_PROJECT}>
          <FolderIcon className="size-5 text-muted-foreground" />
          No project
        </SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <FolderIcon className="size-5 text-muted-foreground" />
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
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

/** A place to drop a file, or tap to choose one. */
function DropZone({
  accept,
  icon: Icon,
  label,
  file,
  detail,
  onFile,
}: {
  accept: string
  icon: typeof FileAudioIcon
  label: string
  file?: string
  detail?: string
  onFile: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const picked = event.target.files?.[0]
          if (picked) onFile(picked)
          event.target.value = ""
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          const dropped = event.dataTransfer.files[0]
          if (dropped) onFile(dropped)
        }}
        className={cn(
          "flex min-h-20 w-full items-center gap-3 rounded-3xl border px-4 py-3 text-left transition-colors hover:bg-muted",
          !file && "border-dashed",
          over && "border-primary bg-primary/5",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
        {file ? (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{file}</span>
            {detail && <span className="text-sm text-muted-foreground">{detail}</span>}
          </span>
        ) : (
          <span className="flex-1 font-medium">{label}</span>
        )}
      </button>
    </>
  )
}

/** The bot and project a new meeting goes to, shared by the upload and the recorder. */
function useTarget() {
  const active = useMeetingBot()
  const bots = useMeetingBots()
  const [botId, setBotId] = useState<string>()
  const profile =
    bots.find((b) => b.id === botId) ?? bots.find((b) => b.id === active?.id) ?? bots[0]
  const projects = useMeetingProjects(profile)
  const noAudio = useNoAudio(profile)
  const [projectId, setProjectId] = useState(NO_PROJECT)
  const project = projects.some((p) => p.id === projectId) ? projectId : undefined
  return { bots, profile, projects, noAudio, projectId, project, setBotId, setProjectId }
}

type Target = ReturnType<typeof useTarget>

function TargetFields({ target }: { target: Target }) {
  const { bots, profile, setBotId, setProjectId } = target
  return (
    <>
      {bots.length > 1 && (
        <div
          className="-mx-6 flex [scrollbar-width:none] gap-2 overflow-x-auto px-6"
          role="group"
          aria-label="Bot"
        >
          {bots.map((option) => {
            const on = option.id === profile?.id
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setBotId(option.id)
                  setProjectId(NO_PROJECT)
                }}
                className={cn(
                  "flex min-h-11 w-20 shrink-0 flex-col items-center gap-1 rounded-3xl border px-2 py-2 text-xs font-medium transition-colors",
                  on ? "border-primary bg-primary/10" : "hover:bg-muted",
                )}
              >
                <Bot id={option.botId} className="size-10" />
                <span className="w-full truncate text-center">{option.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

function ProjectField({ target }: { target: Target }) {
  const { projects, projectId, setProjectId } = target
  if (!projects.length) return null
  return (
    <Field>
      <FieldLabel htmlFor="meeting-project">Project</FieldLabel>
      <ProjectSelect
        id="meeting-project"
        projects={projects}
        value={projectId}
        onChange={setProjectId}
      />
    </Field>
  )
}

/** A recording or a transcript from the device, by its extension, for the bot to write up. */
function UploadForm({ target, onAdded }: { target: Target; onAdded: () => void }) {
  const go = useSwap()
  const { profile, noAudio, project } = target
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<{ file: File; text?: string }>()
  const parsed = picked?.text !== undefined ? parseTranscript(picked.text) : undefined
  const refused = Boolean(picked && !parsed && noAudio)

  const choose = async (file: File) => {
    if (!isTranscript(file)) {
      setPicked({ file })
      return
    }
    if (file.size > MAX_TRANSCRIPT_BYTES) {
      toast.error("That file is too big for a transcript.")
      return
    }
    setPicked({ file, text: await file.text() })
  }

  const ready = Boolean(profile && picked && !refused && (!parsed || parsed.lines.length > 0))

  const add = async () => {
    if (!profile || !picked || !ready || busy) return
    const title = baseName(picked.file.name)
    setBusy(true)
    try {
      const meeting = parsed
        ? await addTranscript(profile, { title, projectId: project, lines: parsed.lines })
        : await addRecording(profile, { title, projectId: project, file: picked.file })
      onAdded()
      go(`/meetings/${meeting.id}`)
    } catch (error) {
      toast.error(message(error, "Couldn't add the meeting."))
    } finally {
      setBusy(false)
    }
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
      : sizeText(picked.file.size)

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        void add()
      }}
    >
      <DropZone
        accept={`${RECORDING_TYPES},${TRANSCRIPT_TYPES}`}
        icon={parsed ? FileTextIcon : FileAudioIcon}
        label="Choose a file"
        file={picked?.file.name}
        detail={detail}
        onFile={(file) => void choose(file)}
      />
      {refused && <Banner>{noAudio}</Banner>}

      <Button type="submit" size="lg" className="h-11 rounded-full" disabled={!ready || busy}>
        Add
      </Button>
    </form>
  )
}

const clockText = (ms: number) => clock(Math.floor(ms / 1000))

/** The room recorded in the app: the whole screen while it runs, then the bot writes it up. */
function RecordForm({ target, onAdded }: { target: Target; onAdded: () => void }) {
  const go = useSwap()
  const { profile, noAudio, project } = target
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const save = useCallback(
    async ({ file }: Recorded) => {
      if (!profile) return
      setOpen(false)
      setSaving(true)
      try {
        const meeting = await addRecording(profile, {
          title: file.name.replace(/\.[^.]+$/, ""),
          projectId: project,
          file,
        })
        onAdded()
        go(`/meetings/${meeting.id}`)
      } catch (error) {
        toast.error(message(error, "Couldn't add the meeting."))
      } finally {
        setSaving(false)
      }
    },
    [profile, project, onAdded, go],
  )
  const recorder = useMeetingRecorder(save)
  const running = recorder.state !== "idle"
  const unavailable = !canRecord() ? "This browser can't record." : noAudio

  const begin = async () => {
    setOpen(await recorder.start())
  }

  return (
    <div className="flex flex-col gap-5">
      {unavailable && <Banner>{unavailable}</Banner>}
      {recorder.error && !running && <Banner>{recorder.error}</Banner>}
      <Button
        type="button"
        size="lg"
        className="h-11 rounded-full"
        disabled={Boolean(unavailable) || !profile || saving}
        onClick={() => void begin()}
      >
        <MicIcon /> Start recording
      </Button>

      <FullscreenPopup
        open={open && running}
        onOpenChange={(next) => {
          if (!next) setConfirming(true)
        }}
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
          <Bot
            id={profile?.botId ?? ""}
            className="size-32"
            animate={recorder.state === "recording"}
          />
          <div className="flex flex-col items-center gap-1">
            <span className="font-mono text-5xl font-semibold tabular-nums" role="timer">
              {clockText(recorder.elapsed)}
            </span>
            <span className="text-sm text-muted-foreground">
              {recorder.state === "paused" ? "Paused" : "Recording"}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-center gap-3 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-12 rounded-full px-6"
            onClick={recorder.state === "paused" ? recorder.resume : recorder.pause}
          >
            {recorder.state === "paused" ? <MicIcon /> : <PauseIcon />}
            {recorder.state === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="lg"
            className="h-12 rounded-full px-6"
            onClick={recorder.end}
          >
            <SquareIcon /> End meeting
          </Button>
        </div>
      </FullscreenPopup>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop recording?</AlertDialogTitle>
            <AlertDialogDescription>
              End the meeting and have it written up, or discard what was recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep recording</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                recorder.discard()
                setOpen(false)
              }}
            >
              Discard
            </AlertDialogAction>
            <AlertDialogAction onClick={recorder.end}>End meeting</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** A new meeting: recorded here, or a recording or transcript for the bot to write up. */
function NewMeeting({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const target = useTarget()
  const [tab, setTab] = useState("record")
  const close = () => onOpenChange(false)
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="md">
        <PopupHeader className="pb-2">
          <PopupTitle>New meeting</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-5 px-6">
          <TargetFields target={target} />
          <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
            <TabsList className="w-full">
              <TabsTrigger value="record">Record</TabsTrigger>
              <TabsTrigger value="upload">Upload</TabsTrigger>
            </TabsList>
            <TabsContent value="record" className="flex flex-col gap-5 pt-5">
              <ProjectField target={target} />
              <RecordForm target={target} onAdded={close} />
            </TabsContent>
            <TabsContent value="upload" className="flex flex-col gap-5 pt-5">
              <ProjectField target={target} />
              <UploadForm target={target} onAdded={close} />
            </TabsContent>
          </Tabs>
        </div>
      </PopupContent>
    </Popup>
  )
}

const STEPS = ["Upload", "Transcribe", "Write", "Ready"]
// A transcript skips the upload and the transcription.
const TRANSCRIPT_STEPS = ["Transcript", "Write", "Ready"]

function stepOf(meeting: Meeting) {
  const step =
    meeting.stage === "uploading"
      ? 0
      : meeting.stage === "transcribing"
        ? 1
        : meeting.stage === "writing"
          ? 2
          : 3
  if (meeting.source !== "transcript") return step
  return meeting.stage === "ready" ? 2 : 1
}

/** Upload, Transcribe, Write, Ready, as dots joined by lines; a failed step is marked. */
function Steps({ meeting }: { meeting: Meeting }) {
  const at = stepOf(meeting)
  const steps = meeting.source === "transcript" ? TRANSCRIPT_STEPS : STEPS
  const failed = isFailed(meeting)
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

function Gone() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
      This meeting is gone.
    </div>
  )
}

/** One meeting: the bot at work on it, then its notes and transcript. */
export function MeetingPage() {
  const { id = "" } = useParams()
  // A fresh view for each meeting: the tab and the line a note cited belong to one.
  return (
    <Gate>
      <MeetingView key={id} />
    </Gate>
  )
}

function MeetingView() {
  const { id = "" } = useParams()
  const { meeting } = useMeeting(id)
  const navigate = useNavigate()
  const { up } = useNav()
  const beside = Boolean(useMeetingsPane())
  const now = useNow()
  const back = useCallback(() => up("/meetings"), [up])
  const [tab, setTab] = useState("notes")
  // The time a note cited, which the transcript tab opens at.
  const [focus, setFocus] = useState<number>()
  // Beside the list a meeting is the top-level screen, so back leaves the app.
  useEffect(() => (beside ? undefined : setBackGuard(() => (back(), true))), [back, beside])
  useRememberOpened("meetings", meeting?.id)

  if (!meeting) return <Gone />

  const seek = (at: number) => {
    setFocus(at)
    setTab("transcript")
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Header
          leading={beside ? null : <BackButton onClick={back} label="Back to Meetings" />}
          title={
            <h1 className="truncate text-base font-semibold tracking-tight">{meeting.title}</h1>
          }
          subtitle={[
            meeting.projectName,
            meeting.duration > 0 && length(meeting.duration),
            formatRelative(meeting.createdAt, now),
          ]
            .filter(Boolean)
            .join(" · ")}
          actions={<MeetingMenu meeting={meeting} onRemoved={back} />}
        />
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 pt-2 pb-8">
          {meeting.stage === "ready" && !isFailed(meeting) ? (
            meeting.notes?.topics.length ? (
              <RecapView
                meeting={meeting}
                notes={meeting.notes}
                onOpen={(topic, at) =>
                  navigate(
                    `/meetings/${meeting.id}/topics/${topic.id}${at === undefined ? "" : `?at=${at}`}`,
                  )
                }
              />
            ) : meeting.notes ? (
              <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
                <TabsList>
                  <TabsTrigger value="notes">Notes</TabsTrigger>
                  <TabsTrigger value="transcript">Transcript</TabsTrigger>
                </TabsList>
                <TabsContent value="notes" className="flex flex-col gap-6 pt-5">
                  <NotesView meeting={meeting} notes={meeting.notes} onSeek={seek} />
                </TabsContent>
                <TabsContent value="transcript" className="pt-3">
                  <TranscriptView lines={meeting.transcript} focus={focus} />
                </TabsContent>
              </Tabs>
            ) : (
              <div className="flex flex-col gap-3" aria-label="Loading">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-32 w-full rounded-3xl" />
              </div>
            )
          ) : (
            <Working meeting={meeting} />
          )}
        </div>
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
          {meeting.notes && (
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
              onClick={() =>
                removeMeeting(meeting)
                  .then(onRemoved)
                  .catch((error) => toast.error(message(error, "Couldn't delete the meeting.")))
              }
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
  const failed = isFailed(meeting)
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
            meeting.error ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-full"
                onClick={() =>
                  retryMeeting(meeting).catch((error) =>
                    toast.error(message(error, "Couldn't try again.")),
                  )
                }
              >
                <RotateCcwIcon data-icon="inline-start" />
                Try again
              </Button>
            ) : undefined
          }
        >
          {meeting.error ?? "The upload didn't finish, so the host never got the whole recording."}
        </Banner>
      )}
    </>
  )
}

const SECTION_LOOK: Record<NoteSection["key"], { icon: LucideIcon; color: string }> = {
  keyPoints: { icon: ListIcon, color: "text-muted-foreground" },
  decisions: { icon: DiamondIcon, color: "text-merged" },
  actions: { icon: CheckIcon, color: "text-primary" },
  questions: { icon: FlagIcon, color: "text-warning" },
}

/** A time a note cites, which opens the transcript there. */
function Stamp({ at, onSeek }: { at: number; onSeek: (at: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSeek(at)}
      aria-label={`Show ${clock(at)} in the transcript`}
      className="relative ml-1.5 inline-flex h-6 items-center rounded-full bg-primary/10 px-2 align-middle text-xs font-medium text-primary tabular-nums transition-colors after:absolute after:-inset-x-1 after:-inset-y-2.5 hover:bg-primary/20 dark:bg-success/15 dark:text-success"
    >
      {clock(at)}
    </button>
  )
}

function Unsourced() {
  return (
    <span className="ml-1.5 inline-flex h-6 items-center rounded-full bg-warning/15 px-2 align-middle text-xs font-medium text-warning">
      Unsourced
    </span>
  )
}

function NoteRow({
  item,
  action,
  onSeek,
}: {
  item: NoteItem
  action: boolean
  onSeek: (at: number) => void
}) {
  return (
    <li className="leading-relaxed">
      {item.text}
      {action && item.owner && (
        <span className="ml-1.5 text-sm text-muted-foreground">({item.owner})</span>
      )}
      {item.cites.map((at) => (
        <Stamp key={at} at={at} onSeek={onSeek} />
      ))}
      {item.unsourced && <Unsourced />}
    </li>
  )
}

/** The summary, then the host's fixed sections; an empty one says so. */
function NotesView({
  meeting,
  notes,
  onSeek,
}: {
  meeting: Meeting
  notes: Notes
  onSeek: (at: number) => void
}) {
  return (
    <>
      <div className="flex gap-3">
        <BotAvatar botId={meeting.bot.botId} />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-sm font-semibold">{meeting.bot.name}</p>
          <p className="text-[15px] leading-relaxed">{notes.summary}</p>
        </div>
      </div>
      <div className="divide-y overflow-hidden rounded-3xl border bg-card">
        {NOTE_SECTIONS.map(({ key, title }) => {
          const { icon: Icon, color } = SECTION_LOOK[key]
          return (
            <section key={key} className="flex flex-col gap-2 px-4 py-3.5">
              <h2
                className={cn(
                  "flex items-center gap-1.5 text-xs font-bold tracking-wide uppercase",
                  color,
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {title}
              </h2>
              {notes[key].length ? (
                <ul className="flex flex-col gap-2">
                  {notes[key].map((item) => (
                    <NoteRow key={item.id} item={item} action={key === "actions"} onSeek={onSeek} />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None recorded</p>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}

/** The transcript as the host heard it, the line a note cited marked. */
function TranscriptView({
  lines,
  focus,
}: {
  lines: Meeting["transcript"]
  focus: number | undefined
}) {
  const rows = useRef(new Map<string, HTMLLIElement>())
  const current = focus === undefined ? undefined : lines.findLast((l) => l.at <= focus)
  const currentId = current?.id
  useEffect(() => {
    if (!currentId) return
    const frame = requestAnimationFrame(() =>
      rows.current.get(currentId)?.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      }),
    )
    return () => cancelAnimationFrame(frame)
  }, [currentId])
  return (
    <ol className="flex flex-col">
      {lines.map((line) => (
        <li
          key={line.id}
          ref={(node) => {
            if (node) rows.current.set(line.id, node)
            else rows.current.delete(line.id)
          }}
          className={cn(
            "-mx-1 flex gap-4 rounded-2xl px-4 py-2.5 transition-colors",
            line.id === currentId && "bg-primary/10",
          )}
        >
          <span
            className={cn(
              "w-12 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums",
              line.id === currentId && "font-semibold text-primary dark:text-success",
            )}
          >
            {clock(line.at)}
          </span>
          <span className="min-w-0 leading-relaxed">{line.text}</span>
        </li>
      ))}
    </ol>
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

const MOMENT_LOOK: Record<MomentKind, { icon: LucideIcon; color: string; title: string }> = {
  decision: { icon: DiamondIcon, color: "text-merged", title: "Decisions" },
  action: { icon: CheckIcon, color: "text-primary", title: "To do" },
  open: { icon: FlagIcon, color: "text-warning", title: "Left open" },
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

/** "3 decisions, 2 to do and 1 open." */
function tally(moments: Moment[]) {
  const count = (kind: MomentKind) => moments.filter((m) => m.kind === kind).length
  const parts = [
    count("decision") && `${count("decision")} decision${count("decision") === 1 ? "" : "s"}`,
    count("action") && `${count("action")} to do`,
    count("open") && `${count("open")} left open`,
  ].filter(Boolean) as string[]
  if (!parts.length) return ""
  return `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`
}

/** The bot's summary, the meeting laid out in time, what came of it and its topics. */
function RecapView({
  meeting,
  notes,
  onOpen,
}: {
  meeting: Meeting
  notes: Notes
  onOpen: (topic: Topic, at?: number) => void
}) {
  const moments = momentsOf(notes)
  const seek = (at: number) => onOpen(topicAt(notes.topics, at), at)
  return (
    <>
      <div className="flex gap-3">
        <BotAvatar botId={meeting.bot.botId} />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-sm font-semibold">{meeting.bot.name}</p>
          <p className="text-[15px] leading-relaxed">
            {notes.summary} {tally(moments)}
          </p>
        </div>
      </div>

      <Timeline meeting={meeting} topics={notes.topics} moments={moments} onOpen={onOpen} />

      <MomentsCard moments={moments} onSeek={seek} />

      <section className="flex flex-col gap-1">
        <h2 className="px-1 pb-1 text-sm font-medium text-muted-foreground">Topics</h2>
        {notes.topics.map((topic, index) => (
          <TopicRow
            key={topic.id}
            topic={topic}
            index={index}
            moments={moments.filter(
              (m) => m.at !== undefined && topicAt(notes.topics, m.at).id === topic.id,
            )}
            onOpen={() => onOpen(topic)}
          />
        ))}
      </section>
    </>
  )
}

/** The meeting laid out in time: its topics as spans, its moments pinned where they happened. */
function Timeline({
  meeting,
  topics,
  moments,
  onOpen,
}: {
  meeting: Meeting
  topics: Topic[]
  moments: Moment[]
  onOpen: (topic: Topic, at?: number) => void
}) {
  const total = Math.max(meeting.duration, topics.at(-1)?.end ?? 0, 1)
  const placed = moments.filter((m) => m.at !== undefined)
  return (
    <section className="rounded-3xl border bg-card px-4 pt-3 pb-3" aria-label="Timeline">
      <div className="relative h-12">
        {placed.map((moment) => (
          <button
            key={moment.id}
            type="button"
            onClick={() => onOpen(topicAt(topics, moment.at!), moment.at)}
            aria-label={`${moment.text}, at ${clock(moment.at!)}`}
            className="absolute top-0 flex size-6 -translate-x-1/2 items-center justify-center rounded-full after:absolute after:-inset-2.5 hover:bg-muted"
            style={{ left: `${(moment.at! / total) * 100}%` }}
          >
            <MomentIcon kind={moment.kind} className="size-3.5" />
          </button>
        ))}
        <div className="absolute inset-x-0 bottom-0 flex h-5 gap-0.5">
          {topics.map((topic, index) => (
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

/** What was decided, what's to do and what's left open. */
function MomentsCard({ moments, onSeek }: { moments: Moment[]; onSeek: (at: number) => void }) {
  const kinds = (Object.keys(MOMENT_LOOK) as MomentKind[]).filter((kind) =>
    moments.some((m) => m.kind === kind),
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
            {MOMENT_LOOK[kind].title}
          </h2>
          <ul className="flex flex-col gap-2">
            {moments
              .filter((m) => m.kind === kind)
              .map((moment) => (
                <li key={moment.id} className="leading-relaxed">
                  {moment.text}
                  {moment.owner && (
                    <span className="ml-1.5 text-sm text-muted-foreground">({moment.owner})</span>
                  )}
                  {moment.at !== undefined ? (
                    <Stamp at={moment.at} onSeek={onSeek} />
                  ) : (
                    <Unsourced />
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
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

/** A topic of a meeting: its summary and quote, and its part of the transcript. */
export function TopicPage() {
  return (
    <Gate>
      <TopicScreen />
    </Gate>
  )
}

function TopicScreen() {
  const { id = "", topic: topicId = "" } = useParams()
  const { meeting } = useMeeting(id)
  const topic = meeting?.notes?.topics.find((t) => t.id === topicId)
  useRememberOpened("meetings", meeting?.id)
  if (!meeting?.notes || !topic) return <Gone />
  return <TopicView key={topic.id} meeting={meeting} notes={meeting.notes} topic={topic} />
}

function TopicView({ meeting, notes, topic }: { meeting: Meeting; notes: Notes; topic: Topic }) {
  const navigate = useNavigate()
  const { up } = useNav()
  const [params] = useSearchParams()
  const from = params.get("at")
  const [position, setPosition] = useState(() => (from === null ? undefined : Number(from)))
  const [tab, setTab] = useState(from === null ? "summary" : "transcript")
  const back = useCallback(() => up(`/meetings/${meeting.id}`), [up, meeting.id])
  useEffect(() => setBackGuard(() => (back(), true)), [back])

  const index = notes.topics.indexOf(topic)
  const next = notes.topics[index + 1]
  const last = index === notes.topics.length - 1
  const lines = meeting.transcript.filter(
    (l) => l.at >= topic.start && (last ? l.at <= topic.end : l.at < topic.end),
  )
  const inTopic = momentsOf(notes).filter(
    (m) =>
      m.at !== undefined && m.at >= topic.start && (last ? m.at <= topic.end : m.at < topic.end),
  )
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
          subtitle={`Topic ${index + 1} of ${notes.topics.length} · ${clock(topic.start)} to ${clock(topic.end)}`}
        />
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-8">
          <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
            <TabsList>
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
              <TranscriptView lines={lines} focus={position} />
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
    </div>
  )
}
