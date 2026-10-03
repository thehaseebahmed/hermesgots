import type { Profile } from "@/lib/db"
import {
  HermesError,
  listCronJobs,
  listCronRuns,
  type CronExecutionRun,
  type CronJob,
} from "@/lib/hermes"

/** Bars shown per job. */
export const HISTORY_LENGTH = 24

export type CronRunStatus = "ok" | "failed" | "running" | "unknown"

/** One cron run from Hermes's execution ledger, through the Memento plugin. */
export interface CronRun {
  id: string
  jobId: string
  startedAt: number
  finishedAt?: number
  status: CronRunStatus
  error?: string
}

/** Hermes mixes unix seconds and ISO strings with an offset. */
function toMillis(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function toRun(run: CronExecutionRun): CronRun | undefined {
  const startedAt = toMillis(run.started_at ?? run.claimed_at)
  if (!startedAt) return undefined
  // A completed agent turn can still fail to deliver.
  const status: CronRunStatus =
    run.status === "completed"
      ? run.delivery_outcome === "failed"
        ? "failed"
        : "ok"
      : run.status === "failed"
        ? "failed"
        : run.status === "claimed" || run.status === "running"
          ? "running"
          : "unknown"
  const error =
    run.error ?? (run.delivery_outcome === "failed" ? "The result couldn't be delivered." : null)
  return {
    id: run.id,
    jobId: run.job_id,
    startedAt,
    finishedAt: toMillis(run.finished_at),
    status,
    error: error ?? undefined,
  }
}

export interface CronState {
  jobs: CronJob[]
  /** Each job's runs, oldest first. */
  runs: Record<string, CronRun[]>
}

/** The Hermes server behind a bot doesn't have the Memento plugin. */
export class PluginMissingError extends Error {
  constructor() {
    super("The Memento plugin isn't installed on this Hermes server.")
    this.name = "PluginMissingError"
  }
}

/** The profile's jobs and their recent runs. */
export async function syncCron(profile: Profile): Promise<CronState> {
  const [jobsResult, ledgerResult] = await Promise.allSettled([
    listCronJobs(profile),
    listCronRuns(profile, HISTORY_LENGTH),
  ])
  if (jobsResult.status === "rejected") throw jobsResult.reason
  if (ledgerResult.status === "rejected") {
    const error = ledgerResult.reason
    // Hermes's 404 for an unknown route skips its CORS middleware, so the browser blocks it and
    // fetch fails without a status. /api/jobs on the same server got through, so that's the plugin.
    const missing = error instanceof HermesError && (error.status === 404 || !error.status)
    throw missing ? new PluginMissingError() : error
  }
  const jobs = jobsResult.value
  const ledger = ledgerResult.value
  const runs: Record<string, CronRun[]> = {}
  for (const job of jobs) {
    runs[job.id] = (ledger[job.id] ?? [])
      .map(toRun)
      .filter((run): run is CronRun => run !== undefined)
      .sort((a, b) => a.startedAt - b.startedAt)
  }
  return { jobs, runs }
}
