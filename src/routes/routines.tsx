import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  EllipsisIcon,
  MenuIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Bot } from "@/components/bot"
import { useOpenDrawer } from "@/components/drawer-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { HISTORY_LENGTH, syncCron } from "@/lib/cron"
import { cronRunsOf, listProfiles, type CronRun, type Profile } from "@/lib/db"
import { formatDuration, formatRelative } from "@/lib/format"
import { HermesError, controlCronJob, type CronJob } from "@/lib/hermes"
import { cn } from "@/lib/utils"

const REFRESH_MS = 60_000

/** Hermes cron jobs, grouped by bot, each with its recent runs as Gatus-style bars. */
export function RoutinesPage() {
  const openDrawer = useOpenDrawer()
  const profiles = useLiveQuery(listProfiles, [])
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, REFRESH_MS)
    const onVisible = () => document.visibilityState === "visible" && refresh()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

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
          <h1 className="flex-1 text-xl font-semibold tracking-tight">Routines</h1>
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            onClick={refresh}
            aria-label="Refresh"
          >
            <RefreshCwIcon />
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {profiles?.map((profile) => (
          <BotRoutines key={profile.id} profile={profile} tick={tick} />
        ))}
        <p className="text-center text-xs text-muted-foreground">
          Hermes only reports each routine's latest run, so the history is what this device has seen
          plus what Hermes's cron sessions show.
        </p>
      </div>
    </div>
  )
}

function describeError(error: unknown) {
  if (error instanceof HermesError) {
    if (error.status === 501) return "Cron isn't available on this Hermes server."
    if (error.status === 404) return "This Hermes version can't list routines yet."
    return error.message
  }
  return error instanceof Error ? error.message : "Couldn't load routines."
}

function BotRoutines({ profile, tick }: { profile: Profile; tick: number }) {
  const [jobs, setJobs] = useState<CronJob[]>()
  const [syncedAt, setSyncedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [ownTick, setOwnTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    syncCron(profile)
      .then((result) => {
        if (cancelled) return
        setJobs(result)
        setSyncedAt(Date.now())
        setError(null)
      })
      .catch((reason) => !cancelled && setError(describeError(reason)))
    return () => {
      cancelled = true
    }
  }, [profile, tick, ownTick])

  const resync = useCallback(() => setOwnTick((n) => n + 1), [])

  return (
    <Card className="rounded-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          <Bot id={profile.botId} className="size-9" />
          <span className="min-w-0 flex-1 truncate">{profile.name}</span>
          {jobs && !error && (
            <span className="text-sm font-normal text-muted-foreground">
              {jobs.length} {jobs.length === 1 ? "routine" : "routines"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !jobs ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading routines…
          </p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No routines yet.</p>
        ) : (
          jobs.map((job) => (
            <JobRow key={job.id} profile={profile} job={job} now={syncedAt} onChanged={resync} />
          ))
        )}
      </CardContent>
    </Card>
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
  const paused = !job.enabled || job.state === "paused"
  if (paused) return <Badge variant="secondary">Paused</Badge>
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

function JobRow({
  profile,
  job,
  now,
  onChanged,
}: {
  profile: Profile
  job: CronJob
  /** When the job was fetched; relative times count from it. */
  now: number
  onChanged: () => void
}) {
  const runs = useLiveQuery(
    async () =>
      (await cronRunsOf(profile.id, job.id).reverse().limit(HISTORY_LENGTH).toArray()).reverse(),
    [profile.id, job.id],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = runs?.find((run) => run.id === selectedId)
  const latest = runs?.at(-1)
  const paused = !job.enabled || job.state === "paused"
  const nextRun = job.nextRunAt ? Date.parse(job.nextRunAt) : NaN
  const slots: (CronRun | null)[] = [
    ...Array<null>(Math.max(0, HISTORY_LENGTH - (runs?.length ?? 0))).fill(null),
    ...(runs ?? []),
  ]

  const act = async (action: "pause" | "resume" | "run") => {
    try {
      await controlCronJob(profile, job.id, action)
      const done = { pause: "Paused", resume: "Resumed", run: "Started" }[action]
      toast.success(`${done} “${job.name}”`)
      onChanged()
      // A manual run starts in the background; look again once it has had a moment.
      if (action === "run") setTimeout(onChanged, 5_000)
    } catch (error) {
      toast.error(describeError(error))
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label={job.name}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium">{job.name}</h3>
            <JobStatus job={job} latest={latest} />
          </div>
          {job.schedule && <p className="text-xs text-muted-foreground">{job.schedule}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className="-mt-1.5 -mr-2 size-11 shrink-0 rounded-full"
                aria-label={`${job.name} options`}
              />
            }
          >
            <EllipsisIcon />
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
              onClick={() => setSelectedId(run.id === selectedId ? null : run.id)}
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
        <span>{runs?.[0] ? formatRelative(runs[0].startedAt, now) : "No history yet"}</span>
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
          {selected.source === "session" && (
            <p className="mt-1 text-xs text-muted-foreground">From Hermes's session history.</p>
          )}
        </div>
      )}
    </section>
  )
}
