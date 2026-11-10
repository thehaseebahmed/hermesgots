import type { Conversation, Profile } from "@/lib/db"
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

/** One cron run from Hermes's execution ledger, through the Gots plugin. */
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

/** The id prefix a routine's row carries, as the plugin derives it: `routine-<job>-<session>`. */
export const ROUTINE_ROW_PREFIX = "routine-"

/**
 * How long after a run ends its delivery may still be published: a row written while the chat was in
 * a turn is queued and lands when the lease clears, so it can trail the run's own end a little.
 */
const RUN_ROW_GRACE = 5 * 60_000

/**
 * The row a run published, where this device holds it: a routine's row is keyed by the job and
 * the session the run wrote — a session Hermes's ledger never names — and stamped with the delivery's
 * own time, which is the run's end. So the row of a run is that job's routine row written while the
 * run was finishing: no other job's can be, and a job that runs twice makes two rows at two times.
 *
 * `undefined` for a run nothing delivered, or whose row this device doesn't hold — a silent run, a
 * delivery this bot never saw, a row the reader deleted — which is the page's to say rather than the
 * run's to open.
 */
export function runRowOf(
  rows: readonly Pick<Conversation, "id" | "createdAt">[],
  jobId: string,
  run: Pick<CronRun, "startedAt" | "finishedAt">,
): string | undefined {
  const prefix = `${ROUTINE_ROW_PREFIX}${jobId}-`
  const end = run.finishedAt ?? run.startedAt
  let found: { id: string; away: number } | undefined
  for (const row of rows) {
    if (!row.id.startsWith(prefix)) continue
    if (row.createdAt < run.startedAt || row.createdAt > end + RUN_ROW_GRACE) continue
    const away = Math.abs(row.createdAt - end)
    if (!found || away < found.away) found = { id: row.id, away }
  }
  return found?.id
}

/** The Hermes server behind a bot doesn't have the Gots plugin. */
export class PluginMissingError extends Error {
  constructor() {
    super("The Gots plugin isn't installed on this Hermes server.")
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
