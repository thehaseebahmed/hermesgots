/**
 * The latest return to the foreground, timed: when it began, and for each stage a resume runs, the
 * milliseconds since it began and the requests the resume made there. Started by the app's return
 * trigger (`onReturn` in `wake.ts`, wired in `main.tsx`), marked at each stage's own site, and read
 * into the device state a bug report carries (`diagResume` in `diagnostics.ts`), so a report can
 * say where a resume spent its time. In memory for this launch only: the newest return replaces the
 * trace, and nothing here is written anywhere. Import-free, so `scripts/test-resume-trace.mjs`
 * drives it as a pure rule.
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
 * How long after a return its marks still count as that resume's own: past this, the session is
 * just running normally, and its polls and reconciles must not keep growing the trace forever.
 */
export const TRACE_WINDOW_MS = 120_000

let trace: ResumeTrace | undefined

/** Begins the trace for this return, replacing any earlier one: the newest return is the trace. */
export function startResumeTrace(at = Date.now(), started = performance.now()) {
  trace = { at, started, stages: {}, requests: {} }
}

/**
 * Records that a stage of the current return finished, and `requests` of them where its site knows
 * the count, as milliseconds since the return. A mark with no trace to land in, or past the window,
 * is dropped: there is no return to attribute it to.
 */
export function markResume(stage: ResumeStage, requests = 0, now = performance.now()) {
  if (!trace) return
  const offset = now - trace.started
  if (offset > TRACE_WINDOW_MS) return
  const offsets = (trace.stages[stage] ??= [])
  offsets.push(Math.round(offset))
  if (requests > 0) trace.requests[stage] = (trace.requests[stage] ?? 0) + requests
}

/** The latest return's trace, or undefined before this launch's first return. */
export const resumeTrace = () => trace
