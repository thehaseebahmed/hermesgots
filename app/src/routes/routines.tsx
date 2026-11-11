import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Navigate, useNavigate, useParams } from "react-router"
import {
  EllipsisIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { botChatsPath, botRoutinesPath } from "@/lib/bot-tabs"
import { LIST_MS, SAFETY_MS } from "@/lib/freshness"
import { BackButton } from "@/components/back-button"
import { ChatHeader } from "@/components/chat/chat-header"
import { Chip, ChipRow } from "@/components/chip"
import { CopyBlock } from "@/components/copy-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import {
  HISTORY_LENGTH,
  PluginMissingError,
  runRowOf,
  syncCron,
  type CronRun,
  type CronState,
} from "@/lib/cron"
import { db, conversationsOf, getActiveProfile, type Conversation, type Profile } from "@/lib/db"
import { useLegacyChat } from "@/lib/legacy-chat"
import { useChanges, useLive } from "@/lib/live"
import { useNav } from "@/lib/nav"
import { setBackGuard } from "@/lib/native"
import { useBotChatsPane } from "@/lib/pane"
import { usePoll } from "@/lib/poll"
import { formatDuration, formatRelative } from "@/lib/format"
import { describeSchedule } from "@/lib/schedule"
import { HermesError, controlCronJob, type CronJob } from "@/lib/hermes"
import { HEADER_BUTTON } from "@/lib/layout"
import { INSTALL_PLUGIN } from "@/lib/repo"
import { cn } from "@/lib/utils"

/**
 * A bot's routines: its jobs and their runs, at `/b/<bot>/routines`. The page names the screen alone:
 * a routine belongs to the bot whose list opened this one, so no face, name or count of the bot is
 * drawn — the top bar is the bot's chat list's, and the pills over the jobs filter them by state.
 */
export function RoutinesPage() {
  const { profileId = "" } = useParams()
  // The answer names the address it ran for, so one bot's row can never pass for another's.
  const answered = useLiveQuery(async () => {
    const bot = profileId ? await db.profiles.get(profileId) : undefined
    return { profileId, bot: bot ?? null }
  }, [profileId])
  const bot = answered && answered.profileId === profileId ? answered.bot : undefined
  // The bot's list stands beside its routines where there is room (`useBotChatsPane`), so the page
  // has nothing to lead back to; below that width the list pushed it and is what back returns to.
  const beside = Boolean(useBotChatsPane(useLegacyChat() === false))
  const { up } = useNav()
  const back = useCallback(() => up(botChatsPath(profileId)), [up, profileId])
  useEffect(() => (beside ? undefined : setBackGuard(() => (back(), true))), [back, beside])
  const [tick, setTick] = useState(0)
  const [pollTick, setPollTick] = useState(0)
  // Which state the reader asked the page for. A page remembers nothing across visits: this is the
  // component's own state, not a kept setting.
  const [filter, setFilter] = useState<Filter>("all")
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  usePoll(() => setPollTick((n) => n + 1), LIST_MS, [], { immediate: false, onShow: false })
  // Coming back reads everything, not just what's due.
  usePoll(refresh, false, [], { immediate: false })

  if (bot === undefined) return null
  // A bot that is gone — deleted here or on another device — lands home rather than on a page it
  // cannot fill.
  if (!bot) return <Navigate to="/" replace />

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/*
        The app's bar in its pinned form (ADR 0140) — the same row, slots and frosted circles the chat
        and the bot's list draw. Its leading control is the way back to that list where the list is not
        already beside this page, its title is the screen's own, its action is Refresh, and the four
        states it filters by are pinned under the row inside the same sticky box, so a long list is
        filtered without scrolling back up to reach them.
      */}
      <ChatHeader
        pinned
        showBot={false}
        leading={!beside && <BackButton label="Back to chats" onClick={back} floating />}
        title="Routines"
        actions={
          <Button
            variant="outline"
            size="icon-lg"
            className={cn(HEADER_BUTTON, "shrink-0 text-muted-foreground")}
            onClick={refresh}
            aria-label="Refresh"
          >
            <RefreshCwIcon />
          </Button>
        }
        below={
          <ChipRow label="Routine states">
            {FILTERS.map(({ key, label }) => (
              <Chip key={key} active={filter === key} onClick={() => setFilter(key)}>
                {label}
              </Chip>
            ))}
          </ChipRow>
        }
      />

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <BotRoutines profile={bot} tick={tick} pollTick={pollTick} filter={filter} />
      </div>
    </div>
  )
}

/**
 * `/routines`, from before a bot's routines had an address under the bot: it lands on the active
 * bot's, which is somewhere sensible for an address this device kept.
 */
export function RoutinesHome() {
  const active = useLiveQuery(async () => (await getActiveProfile()) ?? null, [])
  if (active === undefined) return null
  return active ? <Navigate to={botRoutinesPath(active.id)} replace /> : <Navigate to="/" replace />
}

function describeError(error: unknown) {
  if (error instanceof HermesError) {
    if (error.status === 501) return "Cron isn't available on this Hermes server."
    if (error.status === 404) return "This Hermes version can't list routines yet."
    return error.message
  }
  return error instanceof Error ? error.message : "Couldn't load routines."
}

/** The four states the page's pills name, and the page is filtered by. */
type Filter = "all" | "healthy" | "paused" | "failing"

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "healthy", label: "Healthy" },
  { key: "paused", label: "Paused" },
  { key: "failing", label: "Failing" },
]

const isPaused = (job: CronJob) => !job.enabled || job.state === "paused"

/**
 * A job that is failing now: by the streak it is on, or by what its last run answered — the run's own
 * error, or a run that succeeded and whose delivery did not.
 */
const isFailing = (job: CronJob) =>
  job.failureStreak > 0 || job.lastStatus === "error" || job.lastStatus === "delivery_failed"

/** What each pill keeps, and the one rule the pills and their empty lines both read. */
const SHOWS: Record<Filter, (job: CronJob) => boolean> = {
  all: () => true,
  healthy: (job) => job.enabled && !isFailing(job),
  paused: isPaused,
  failing: isFailing,
}

/** What a pill says when it holds nothing, in the page's own words rather than an empty box. */
const EMPTY: Record<Filter, string> = {
  all: "No routines yet.",
  healthy: "No healthy routines.",
  paused: "No paused routines.",
  failing: "No failing routines.",
}

function PluginMissing() {
  return (
    <Card className="gap-3 rounded-3xl px-4 py-4">
      <p className="text-sm">
        Routines need the Gots plugin on this Hermes server. Install it from the Hermes CLI:
      </p>
      <CopyBlock label="Copy install commands" text={INSTALL_PLUGIN} />
    </Card>
  )
}

function BotRoutines({
  profile,
  tick,
  pollTick,
  filter,
}: {
  profile: Profile
  tick: number
  /** Timed refreshes, which a bot whose server streams its changes needs far less of. */
  pollTick: number
  /** The state the page is asked for: the pills' own rule decides which jobs are drawn. */
  filter: Filter
}) {
  const [cron, setCron] = useState<CronState>()
  const [syncedAt, setSyncedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pluginMissing, setPluginMissing] = useState(false)
  const [ownTick, setOwnTick] = useState(0)
  const live = useLive(profile)
  // The rows this bot published for its runs: the only way a run's session is named here, since
  // Hermes's ledger keeps the execution and the session apart.
  const published = useLiveQuery(
    async () =>
      conversationsOf(profile.id)
        .filter((chat) => Boolean(chat.routine))
        .toArray(),
    [profile.id],
  )
  const cronTick = useChanges("cron", profile)
  const timedTick = live ? Math.floor(pollTick / (SAFETY_MS / LIST_MS)) : pollTick
  const jobs = cron?.jobs
  const shown = jobs?.filter(SHOWS[filter])

  useEffect(() => {
    let cancelled = false
    syncCron(profile)
      .then((result) => {
        if (cancelled) return
        setCron(result)
        setSyncedAt(Date.now())
        setError(null)
        setPluginMissing(false)
      })
      .catch((reason) => {
        if (cancelled) return
        setPluginMissing(reason instanceof PluginMissingError)
        setError(describeError(reason))
      })
    return () => {
      cancelled = true
    }
  }, [profile, tick, ownTick, timedTick, cronTick])

  const resync = useCallback(() => setOwnTick((n) => n + 1), [])

  return (
    <div className="flex flex-col gap-3">
      {pluginMissing ? (
        <PluginMissing />
      ) : error ? (
        // A host that answered with a refusal says so where its jobs would be: the page has no bot
        // header left to wear an Unreachable badge, and a bar with a Refresh is the way to ask again.
        <Card className="gap-1 rounded-3xl px-4 py-4">
          <p className="text-sm">{error}</p>
          <p className="text-xs text-muted-foreground">Refresh asks the bot's server again.</p>
        </Card>
      ) : !jobs ? (
        <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading routines…
        </p>
      ) : jobs.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">{EMPTY.all}</p>
      ) : !shown?.length ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">{EMPTY[filter]}</p>
      ) : (
        shown.map((job) => (
          <JobCard
            key={job.id}
            profile={profile}
            job={job}
            runs={cron?.runs[job.id] ?? []}
            published={published ?? []}
            now={syncedAt}
            onChanged={resync}
          />
        ))
      )}
    </div>
  )
}

const STATUS_LABEL: Record<CronRun["status"], string> = {
  ok: "Succeeded",
  failed: "Failed",
  running: "Running",
  unknown: "Unknown outcome",
}

const BAR_COLOR: Record<CronRun["status"], string> = {
  ok: "bg-success",
  failed: "bg-destructive",
  running: "bg-warning",
  unknown: "bg-muted-foreground/40",
}

function JobStatus({ job, latest }: { job: CronJob; latest?: CronRun }) {
  if (isPaused(job)) return <Badge variant="secondary">Paused</Badge>
  if (job.state === "running" || latest?.status === "running") {
    return <Badge className="bg-warning/15 text-warning">Running</Badge>
  }
  if (job.failureStreak > 0 || latest?.status === "failed") {
    return <Badge variant="destructive">Failing</Badge>
  }
  if (!latest) return <Badge variant="outline">No runs yet</Badge>
  return <Badge className="bg-success/15 text-success">Healthy</Badge>
}

function formatWhen(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function JobCard({
  profile,
  job,
  runs,
  published,
  now,
  onChanged,
}: {
  profile: Profile
  job: CronJob
  /** Oldest first. */
  runs: CronRun[]
  /** This bot's routine rows, which name the sessions its runs wrote. */
  published: Conversation[]
  /** When the job was fetched; relative times count from it. */
  now: number
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<"pause" | "resume" | "run" | null>(null)
  const selected = runs.find((run) => run.id === selectedId)
  const latest = runs.at(-1)
  const paused = isPaused(job)
  const nextRun = job.nextRunAt ? Date.parse(job.nextRunAt) : NaN
  const schedule = describeSchedule(job.schedule, job.nextRunAt)
  const slots: (CronRun | null)[] = [
    ...Array<null>(Math.max(0, HISTORY_LENGTH - runs.length)).fill(null),
    ...runs.slice(-HISTORY_LENGTH),
  ]

  /**
   * A bar picks its run: one whose delivery published a row opens that row — the same read-only screen
   * the bot's list opens it on — and one with no row of its own, because it was silent or its row
   * is gone from this device, says what happened here in the card under the bars.
   */
  const pick = (run: CronRun) => {
    const row = runRowOf(published, job.id, run)
    if (row) return navigate(`/c/${row}`, { state: { bot: profile.id } })
    setSelectedId(run.id === selectedId ? null : run.id)
  }

  const act = async (action: "pause" | "resume" | "run") => {
    setPending(action)
    try {
      await controlCronJob(profile, job.id, action)
      const done = { pause: "Paused", resume: "Resumed", run: "Started" }[action]
      toast.success(`${done} “${job.name}”`)
      onChanged()
      // A manual run starts in the background; look again once it has had a moment.
      if (action === "run") setTimeout(onChanged, 5_000)
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setPending(null)
    }
  }

  return (
    <Card className="gap-2 rounded-3xl px-4 py-3" aria-label={job.name}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium">{job.name}</h3>
            <JobStatus job={job} latest={latest} />
          </div>
          {schedule && <p className="text-xs text-muted-foreground">{schedule}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className="-mt-1.5 -mr-2 size-11 shrink-0 rounded-full"
                aria-label={`${job.name} options`}
                disabled={pending !== null}
              />
            }
          >
            {pending !== null ? <Spinner className="size-4" /> : <EllipsisIcon />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => act("run")}>
              <RotateCwIcon />
              Run now
            </DropdownMenuItem>
            {paused ? (
              <DropdownMenuItem onClick={() => act("resume")}>
                <PlayIcon />
                Resume
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => act("pause")}>
                <PauseIcon />
                Pause
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex h-11 items-center gap-[3px]">
        {slots.map((run, index) =>
          run ? (
            <button
              key={run.id}
              type="button"
              onClick={() => pick(run)}
              aria-label={`${STATUS_LABEL[run.status]}, ${formatWhen(run.startedAt)}`}
              aria-pressed={run.id === selectedId}
              className="flex h-full min-w-0 flex-1 items-center outline-none"
            >
              <span
                className={cn(
                  "h-7 w-full rounded-full transition-[height,opacity]",
                  BAR_COLOR[run.status],
                  run.id === selectedId && "h-9 ring-2 ring-ring ring-offset-2 ring-offset-card",
                )}
              />
            </button>
          ) : (
            <span key={`empty-${index}`} className="h-7 min-w-0 flex-1 rounded-full bg-muted" />
          ),
        )}
      </div>

      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{runs[0] ? formatRelative(runs[0].startedAt, now) : "No history yet"}</span>
        <span>
          {paused
            ? "Paused"
            : Number.isNaN(nextRun)
              ? latest
                ? `Last ${formatRelative(latest.startedAt, now)}`
                : ""
              : nextRun <= now
                ? "Due now"
                : `Next ${formatRelative(nextRun, now)}`}
        </span>
      </div>

      {selected && (
        <div className="rounded-2xl bg-muted px-3 py-2 text-sm">
          <p className="font-medium">
            {STATUS_LABEL[selected.status]} · {formatWhen(selected.startedAt)}
            {selected.finishedAt && selected.finishedAt > selected.startedAt && (
              <span className="font-normal text-muted-foreground">
                {" "}
                · took {formatDuration(selected.finishedAt - selected.startedAt)}
              </span>
            )}
          </p>
          {selected.error && (
            <p className="mt-1 text-xs break-words text-destructive">{selected.error}</p>
          )}
        </div>
      )}
    </Card>
  )
}
