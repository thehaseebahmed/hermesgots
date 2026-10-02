import { cronRunsOf, db, type CronRun, type CronRunStatus, type Profile } from "@/lib/db"
import {
  cronSessionFailed,
  listCronJobs,
  listCronSessions,
  type CronJob,
  type CronSession,
} from "@/lib/hermes"

/** Bars shown per job. */
export const HISTORY_LENGTH = 24
const KEEP_RUNS = HISTORY_LENGTH * 2
/** Two sightings of one run (ledger claim vs. session start) can be a little apart. */
const SAME_RUN_MS = 120_000
/** A session that never ended is presumed crashed after this long. */
const STILL_RUNNING_MS = 3_600_000

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

const failedStatus = (status?: string | null) => status === "error" || status === "delivery_failed"

/** The job's latest run, from the execution ledger when Hermes sends it, else the job record. */
function observedRun(job: CronJob): Omit<CronRun, "id" | "profileId"> | undefined {
  const lastRunAt = toMillis(job.lastRunAt)
  const execution = job.latestExecution
  const startedAt = toMillis(execution?.started_at ?? execution?.claimed_at)
  if (execution && startedAt) {
    let status: CronRunStatus =
      execution.status === "completed"
        ? "ok"
        : execution.status === "failed"
          ? "failed"
          : execution.status === "unknown"
            ? "unknown"
            : "running"
    // A completed agent turn can still fail to deliver; the job record knows.
    if (status === "ok" && failedStatus(job.lastStatus) && (lastRunAt ?? 0) >= startedAt) {
      status = "failed"
    }
    return {
      jobId: job.id,
      startedAt,
      finishedAt: toMillis(execution.finished_at),
      status,
      error: execution.error ?? (status === "failed" ? (job.lastError ?? undefined) : undefined),
      source: "observed",
    }
  }
  if (!lastRunAt) return undefined
  // Older Hermes: last_run_at is stamped when the run finishes.
  return {
    jobId: job.id,
    startedAt: lastRunAt,
    finishedAt: lastRunAt,
    status: job.lastStatus === "ok" ? "ok" : failedStatus(job.lastStatus) ? "failed" : "unknown",
    error: job.lastError ?? undefined,
    source: "observed",
  }
}

/** `cron_<jobId>_<YYYYmmdd_HHMMSS>`, stamped in the server's local time. */
function sessionStart(session: CronSession, jobId: string) {
  const started = toMillis(session.started_at)
  if (started) return started
  const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(
    session.id.slice(`cron_${jobId}_`.length),
  )
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number)
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/** Whether each `cron_complete` session ended on a failed turn, keyed by session id. */
type Verdicts = Map<string, boolean>

function sessionRun(
  session: CronSession,
  jobId: string,
  verdicts: Verdicts,
): Omit<CronRun, "id" | "profileId"> | undefined {
  const startedAt = sessionStart(session, jobId)
  if (!startedAt) return undefined
  const finishedAt = toMillis(session.ended_at)
  const failed = verdicts.get(session.id)
  const status: CronRunStatus =
    session.end_reason === "cron_complete"
      ? failed
        ? "failed"
        : "ok"
      : session.end_reason === "cron_incomplete_no_output"
        ? "failed"
        : !finishedAt && Date.now() - startedAt < STILL_RUNNING_MS
          ? "running"
          : "unknown"
  return { jobId, startedAt, finishedAt, status, source: "session", checked: failed !== undefined }
}

function sameRun(run: CronRun, startedAt: number) {
  const end = (run.finishedAt ?? run.startedAt) + SAME_RUN_MS
  return startedAt >= run.startedAt - SAME_RUN_MS && startedAt <= end
}

const jobSessions = (job: CronJob, sessions: CronSession[]) =>
  sessions.filter((session) => session.id.startsWith(`cron_${job.id}_`))

/**
 * Checks the transcripts of `cron_complete` sessions that haven't been checked yet. Only the newest
 * `KEEP_RUNS` per job, since older runs are pruned and would be fetched again on every sync.
 */
async function checkSessions(profile: Profile, jobs: CronJob[], sessions: CronSession[]) {
  const stored = await db.cronRuns.where("profileId").equals(profile.id).toArray()
  const pending: string[] = []
  for (const job of jobs) {
    const settled = stored.filter(
      (run) => run.jobId === job.id && (run.source === "observed" || run.checked),
    )
    const newest = jobSessions(job, sessions)
      .map((session) => ({ session, startedAt: sessionStart(session, job.id) ?? 0 }))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, KEEP_RUNS)
    for (const { session, startedAt } of newest) {
      if (session.end_reason !== "cron_complete" || !startedAt) continue
      if (settled.some((run) => sameRun(run, startedAt))) continue
      pending.push(session.id)
    }
  }
  const verdicts: Verdicts = new Map()
  await Promise.all(
    pending.map(async (id) => {
      const failed = await cronSessionFailed(profile, id)
      if (failed !== undefined) verdicts.set(id, failed)
    }),
  )
  return verdicts
}

async function mergeRuns(
  profileId: string,
  job: CronJob,
  sessions: CronSession[],
  verdicts: Verdicts,
) {
  const runs = await cronRunsOf(profileId, job.id).toArray()
  const put = async (run: Omit<CronRun, "id" | "profileId">) => {
    const existing = runs.find((candidate) => sameRun(candidate, run.startedAt))
    if (existing) {
      // What the job reports beats what a session implies; a checked session beats an unchecked one.
      const replace =
        run.source === "observed" ||
        (existing.source === "session" && (run.checked || !existing.checked))
      if (replace) {
        Object.assign(existing, { ...run, startedAt: existing.startedAt })
        await db.cronRuns.put(existing)
      }
      return
    }
    const added = { ...run, profileId, id: `${profileId}:${job.id}:${run.startedAt}` }
    runs.push(added)
    await db.cronRuns.put(added)
  }

  const observed = observedRun(job)
  if (observed) await put(observed)
  for (const session of jobSessions(job, sessions)) {
    const run = sessionRun(session, job.id, verdicts)
    if (run) await put(run)
  }

  runs.sort((a, b) => b.startedAt - a.startedAt)
  // Hermes counts consecutive failed runs; a session can't tell a failed delivery from a good one.
  const finished = runs.filter((run) => run.status !== "running")
  for (const run of finished.slice(0, job.failureStreak)) {
    if (run.status !== "failed") await db.cronRuns.update(run.id, { status: "failed" })
  }
  await db.cronRuns.bulkDelete(runs.slice(KEEP_RUNS).map((run) => run.id))
}

/** Fetches the profile's jobs and folds what they and the cron sessions say into `cronRuns`. */
export async function syncCron(profile: Profile) {
  const [jobs, sessions] = await Promise.all([listCronJobs(profile), listCronSessions(profile)])
  const verdicts = await checkSessions(profile, jobs, sessions)
  await db.transaction("rw", db.cronRuns, async () => {
    for (const job of jobs) await mergeRuns(profile.id, job, sessions, verdicts)
    const live = new Set(jobs.map((job) => job.id))
    await db.cronRuns
      .where("profileId")
      .equals(profile.id)
      .filter((run) => !live.has(run.jobId))
      .delete()
  })
  return jobs
}
