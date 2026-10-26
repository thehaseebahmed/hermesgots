/**
 * The latest return to the foreground, timed: in memory for this launch only, replaced by the
 * newest return, never written anywhere. The device state a bug report carries reads it through
 * `diagResume` in `diagnostics.ts`. Import-free, so `scripts/test-resume-trace.mjs` drives it.
 */

/** Every stage a resume can mark; the dump picks by this list, so nothing else can ride along. */
export const RESUME_STAGES = [
  "stream-hello",
  "sync-start",
  "sync-end",
  "account-docs-end",
  "registry-end",
  "chats-merge-end",
  "runs-live-end",
  "open-chat-caught-up",
] as const

export type ResumeStage = (typeof RESUME_STAGES)[number]

export interface ResumeTrace {
  /** When the return happened on this device's clock, to date the trace in a report. */
  at: number
  /** `performance.now()` at the return: every offset below is measured from here. */
  started: number
  /** Stage -> the offsets it landed at (milliseconds since the return), in landing order. */
  stages: Partial<Record<ResumeStage, number[]>>
  /** Stage -> the requests the resume made there, so a stage that ran twice counts up. */
  requests: Partial<Record<ResumeStage, number>>
}

/**
 * How long after a return its marks still count as that resume's own. Past it the session is just
 * running normally, and a screen left polling would keep growing the dump with marks that are no
 * longer the resume.
 */
export const TRACE_WINDOW_MS = 120_000

/** The offsets one stage keeps: enough to show it ran again, not every poll of a window. */
export const MARKS_PER_STAGE = 8

let trace: ResumeTrace | undefined

export interface ResumeStart {
  /** Defaults to `Date.now()`. */
  at?: number
  /** Defaults to `performance.now()`. */
  started?: number
}

/** The newest return replaces the trace. */
export function startResumeTrace({
  at = Date.now(),
  started = performance.now(),
}: ResumeStart = {}) {
  trace = { at, started, stages: {}, requests: {} }
}

export interface ResumeMark {
  /** The requests the stage made, where its site knows the count. */
  requests?: number
  /** Defaults to `performance.now()`; the tests pass one. */
  now?: number
}

/** A mark with no trace to land in, or past the window, is dropped: there is no return to attribute it to. */
export function markResume(stage: ResumeStage, { requests, now }: ResumeMark = {}) {
  if (!trace) return
  const offset = (now ?? performance.now()) - trace.started
  if (!Number.isFinite(offset) || offset > TRACE_WINDOW_MS) return
  const offsets = (trace.stages[stage] ??= [])
  if (offsets.length < MARKS_PER_STAGE) offsets.push(Math.round(offset))
  if (requests) trace.requests[stage] = (trace.requests[stage] ?? 0) + requests
}

/** A copy, so later marks can't appear in a trace a reader already holds. */
export function resumeTrace(): ResumeTrace | undefined {
  if (!trace) return
  const stages: ResumeTrace["stages"] = {}
  for (const stage of RESUME_STAGES) {
    const offsets = trace.stages[stage]
    if (offsets) stages[stage] = [...offsets]
  }
  return { at: trace.at, started: trace.started, stages, requests: { ...trace.requests } }
}
