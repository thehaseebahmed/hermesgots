/**
 * Where a session stands, read in one place for every screen that draws it — the Code screen's rows
 * and a chat's pill — from what the host and this device already know.
 *
 * `live` is what the plugin's `runs/live` reports of the session's own turn, `local` what this
 * device sees of it (exact here and invisible elsewhere), and `subagents` how many of the session's
 * subagents the host says still work. That last one is the whole point: a background delegation
 * outlives the turn that dispatched it, so a chat whose turn has ended is still working while a
 * subagent it started is, and every screen reads it off the poll it already makes rather than a read
 * per session. A question or an approval still comes first, since that is what wants the user.
 *
 * Pure: no imports, no clock, so `scripts/test-session-work.mjs` runs it as a rule.
 */

export type SessionState = "working" | "waiting" | "idle" | "resolved" | "discarded"

/** A thread's pill: a session's states, plus a reply that failed. */
export type ThreadState = "working" | "waiting" | "failed" | "idle"

/** The session's own run, as the plugin reports it. */
export type LiveTurn = "running" | "waiting_for_approval"

/** What this device sees of the session's turn. */
export interface LocalTurn {
  streaming?: boolean
  waiting?: boolean
}

/** The facts a state is read from, beyond the host's and this device's. */
export interface SessionFacts {
  resolvedAt?: number
  discardedAt?: number
  planPending?: boolean
}

const working = (subagents?: number) => (subagents ?? 0) > 0

/**
 * Where a session stands. A discarded or resolved one says so first, then what wants the user, then
 * anything at work — its own turn, or the subagents it left running.
 */
export function sessionState(
  conversation: SessionFacts,
  live?: LiveTurn,
  local?: LocalTurn,
  subagents?: number,
): SessionState {
  if (conversation.discardedAt) return "discarded"
  if (conversation.resolvedAt) return "resolved"
  if (local?.waiting || live === "waiting_for_approval" || conversation.planPending)
    return "waiting"
  if (local?.streaming || live === "running" || working(subagents)) return "working"
  return "idle"
}

/**
 * A thread's state as its card draws it. A reply that failed says so only once nothing of the
 * thread's is at work: a subagent still writing is the thread still working, and its failure is the
 * turn that is already over.
 */
export function threadState(thread: {
  /** A question or an approval waits on the user here. */
  waiting?: boolean
  /** This device's newest reply is still streaming. */
  streaming?: boolean
  /** This device's newest reply failed. */
  failed?: boolean
  /** How many of the thread's subagents the host still holds at work. */
  subagents?: number
}): ThreadState {
  if (thread.waiting) return "waiting"
  if (thread.streaming || working(thread.subagents)) return "working"
  if (thread.failed) return "failed"
  return "idle"
}
