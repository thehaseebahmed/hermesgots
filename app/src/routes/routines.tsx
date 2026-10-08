import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  MenuIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Bot } from "@/components/bot"
import { CopyBlock } from "@/components/copy-block"
import { useOpenDrawer } from "@/components/drawer-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import {
  HISTORY_LENGTH,
  PluginMissingError,
  syncCron,
  type CronRun,
  type CronState,
} from "@/lib/cron"
import { listEnabledProfiles, type Profile } from "@/lib/db"
import { SAFETY_MS, useChanges, useLive } from "@/lib/live"
import { formatDuration, formatRelative } from "@/lib/format"
import { describeSchedule } from "@/lib/schedule"
import { HermesError, INSTALL_PLUGIN, controlCronJob, type CronJob } from "@/lib/hermes"
import { cn } from "@/lib/utils"

const REFRESH_MS = 60_000

/** Hermes cron jobs, grouped by bot, each with its recent runs as Gatus-style bars. */
export function RoutinesPage() {
  const openDrawer = useOpenDrawer()
  const profiles = useLiveQuery(listEnabledProfiles, [])
  const [tick, setTick] = useState(0)
  const [pollTick, setPollTick] = useState(0)
  const [collapsed, setOpen] = useCollapsedBots()
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setPollTick((n) => n + 1)
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

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {profiles?.map((profile) => (
          <BotRoutines
            key={profile.id}
            profile={profile}
            tick={tick}
            pollTick={pollTick}
            open={!collapsed.has(profile.id)}
            onOpenChange={(open) => setOpen(profile.id, open)}
          />
        ))}
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

const COLLAPSED_KEY = "memento:routines:collapsed"

/** Bots whose routines are folded away; a per-device convenience, so localStorage is enough. */
function useCollapsedBots() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]")
      return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [])
    } catch {
      return new Set<string>()
    }
  })
  const setOpen = useCallback((profileId: string, open: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (open) next.delete(profileId)
      else next.add(profileId)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // Private mode or blocked storage: it just won't be remembered.
      }
      return next
    })
  }, [])
  return [collapsed, setOpen] as const
}

const isPaused = (job: CronJob) => !job.enabled || job.state === "paused"

/** How many routines are failing now. */
function failingCount({ jobs, runs }: CronState) {
  return jobs.filter((job) => {
    if (isPaused(job)) return false
    const latest = runs[job.id]?.findLast((run) => run.status !== "running")
    return job.failureStreak > 0 || latest?.status === "failed"
  }).length
}

function PluginMissing() {
  return (
    <Card className="gap-3 rounded-3xl px-4 py-4">
      <p className="text-sm">
        Routines need the Memento plugin on this Hermes server. Install it from the Hermes CLI:
      </p>
      <CopyBlock label="Copy install commands" text={INSTALL_PLUGIN} />
    </Card>
  )
}

function BotRoutines({
  profile,
  tick,
  pollTick,
  open,
  onOpenChange,
}: {
  profile: Profile
  tick: number
  /** Timed refreshes, which a bot whose server streams its changes needs far less of. */
  pollTick: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [cron, setCron] = useState<CronState>()
  const [syncedAt, setSyncedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pluginMissing, setPluginMissing] = useState(false)
  const [ownTick, setOwnTick] = useState(0)
  const live = useLive(profile)
  const cronTick = useChanges("cron", profile)
  const timedTick = live ? Math.floor(pollTick / (SAFETY_MS / REFRESH_MS)) : pollTick
  const jobs = cron?.jobs
  const failing = cron && !error ? failingCount(cron) : 0

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
    <Collapsible
      open={open && (!error || pluginMissing)}
      onOpenChange={onOpenChange}
      disabled={!!error && !pluginMissing}
    >
      <div className="flex items-center gap-2">
        <CollapsibleTrigger className="group/bot flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[disabled]/bot:opacity-40 group-data-[panel-open]/bot:rotate-90" />
          <Bot id={profile.botId} className="size-9" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{profile.name}</span>
            {jobs && !error && (
              <span className="block text-xs text-muted-foreground">
                {jobs.length} {jobs.length === 1 ? "routine" : "routines"}
              </span>
            )}
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            {failing > 0 && (
              <Badge variant="destructive">
                <CircleAlertIcon /> {failing} failing
              </Badge>
            )}
          </span>
        </CollapsibleTrigger>
        {error && !pluginMissing && (
          <Popover>
            <PopoverTrigger
              openOnHover
              className="flex min-h-11 shrink-0 items-center rounded-2xl px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Badge variant="destructive">
                <CircleAlertIcon /> Unreachable
              </Badge>
            </PopoverTrigger>
            <PopoverContent align="end" className="break-words text-destructive">
              {error}
            </PopoverContent>
          </Popover>
        )}
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 pt-2">
          {pluginMissing ? (
            <PluginMissing />
          ) : !jobs ? (
            <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading routines…
            </p>
          ) : jobs.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">No routines yet.</p>
          ) : (
            jobs.map((job) => (
              <JobCard
                key={job.id}
                profile={profile}
                job={job}
                runs={cron?.runs[job.id] ?? []}
                now={syncedAt}
                onChanged={resync}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
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
  now,
  onChanged,
}: {
  profile: Profile
  job: CronJob
  /** Oldest first. */
  runs: CronRun[]
  /** When the job was fetched; relative times count from it. */
  now: number
  onChanged: () => void
}) {
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
