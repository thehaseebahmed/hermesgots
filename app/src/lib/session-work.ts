/**
 * Where a session stands, read in one place for every screen that draws it — the Code screen's rows
 * and a chat's pill — from what the host and this device already know.
 *
 * `live` is what the plugin's `runs/live` reports of the session's own turn, `local` what this
 * device sees of it (exact here and invisible elsewhere), and `subagents` how many of the session's
 * subagents the host says still work. The session's own run is read first, since it is the primary
 * fact: while the run runs, the session is working, and no wait mark a moment behind it — a plan the
 * host hasn't recorded as answered, an approval the run has moved past — reads it as waiting.
 *
 * The subagents are the other half of what is at work: a background delegation outlives the turn
 * that dispatched it, so a chat whose turn has ended is still working while a subagent it started
 * is, and every screen reads it off the poll it already makes rather than a read per session. A
 * question or an approval still comes first over those, since that is what wants the user.
 *
 * One facts object and one ladder: a thread's pill is this answer with no session of its own to be
 * resolved or discarded, so the two can't drift.
 *
 * Pure: no clock, and the one value it imports (`pull-state.ts`) is a rule's own — so
 * `scripts/test-session-work.mjs` drives it as a rule.
 */

import { prChecksWait, prIsLive } from "./pull-state.ts"
import type { Conversation } from "@/lib/db"

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

/** The facts a session's state is read from, beyond the host's and this device's. */
export interface SessionFacts {
  resolvedAt?: number
  discardedAt?: number
  planPending?: boolean
  /** The session's own run, as the plugin reports it. */
  live?: LiveTurn
  /** What this device sees of the turn. */
  local?: LocalTurn
  /** How many of the session's subagents the host still holds at work. */
  subagents?: number
}

/** The facts a thread's pill is read from: a reply's own, and the subagents it left working. */
export interface ThreadFacts {
  /** A question or an approval waits on the user here. */
  waiting?: boolean
  /** This device's newest reply is still streaming. */
  streaming?: boolean
  /** This device's newest reply failed. */
  failed?: boolean
  /** How many of the thread's subagents the host still holds at work. */
  subagents?: number
}

const working = (subagents?: number) => (subagents ?? 0) > 0

/**
 * Where a session stands. The session's own run is the first rung: while it runs the session is
 * working, and nothing settled or waiting behind it is read. Then a discarded or resolved one says
 * so, then what wants the user, then the subagents its turn left running (a reply streaming here has
 * already been read at the top), then nothing at all.
 */
export function sessionState(facts: SessionFacts): SessionState {
  if (runInFlight(facts.live, facts.local)) return "working"
  if (facts.discardedAt) return "discarded"
  if (facts.resolvedAt) return "resolved"
  if (facts.local?.waiting || facts.live === "waiting_for_approval" || facts.planPending)
    return "waiting"
  if (working(facts.subagents)) return "working"
  return "idle"
}

/**
 * Whether the session's own run is in flight — the primary fact every other claim is read against.
 * The host's status answers first: `running` is the run running, so a wait mark this device or an
 * earlier poll still holds never outranks it, and `waiting_for_approval` is the run blocked on the
 * user rather than running. With no answer from the host, this device's own newest reply decides:
 * still streaming is the run running, unless an approval or a question in it waits.
 */
function runInFlight(live?: LiveTurn, local?: LocalTurn): boolean {
  if (live) return live === "running"
  return Boolean(local?.streaming) && !local?.waiting
}

/**
 * Whether a session's run has finished: it has ended — no run of it is in flight at the host and
 * this device's own reply is not still streaming — and no subagent it left at work still runs.
 *
 * One answer to "is the run over", for every screen that draws what a run still has to do. The
 * two halves arrive at different moments: a turn's end closes its run while a background
 * delegation the turn dispatched carries on, and a run started elsewhere lists at the host before
 * this device streams a word of it. Reading either half alone called a run finished while it was
 * still working — a stop mark on a list the agent was working through, a push saying the run was
 * done while its subagents ran.
 *
 * The host's own status decides first, and its presence is the answer: `waiting_for_approval` is
 * a run still there, blocked on the user, which is not a run that has ended.
 */
export function runFinished(facts: Pick<SessionFacts, "live" | "local" | "subagents">): boolean {
  const inFlight = facts.live !== undefined || Boolean(facts.local?.streaming)
  return !inFlight && !working(facts.subagents)
}

/** The slice of a session `sessionGroup` reads: its closure and wait marks, and its pull requests. */
type SessionPrs = Pick<Conversation, "resolvedAt" | "discardedAt" | "planPending" | "prs">

/** A session's own moments and its pull requests: what last activity and the unread dot read. */
export type SessionActivity = Pick<Conversation, "updatedAt" | "resolvedAt" | "discardedAt" | "prs">

/** Where a Code row's session stands: the group's state, and whether a pull request's arrow claims it. */
export interface SessionClaim {
  state: SessionState
  prTick: boolean
}

/**
 * Where a Code row's session stands, with its pull requests claimed in: the highest claim wins, and
 * a session something runs for claims the row outright — Working first, before a closed mark and
 * before every wait, so neither a wait mark a run has moved past nor a live pull request's checks
 * running or failed (which wait on the watcher rather than the agent) move it to Waiting for You
 * while it works. Among sessions nothing runs for: closed first, then anything waiting on the user —
 * a question, an approval, a plan or a stall — then a live pull request's checks, then a live pull
 * request with nothing wrong still waiting for its review and merge, as it always has, then idle.
 */
export function sessionGroup(
  conversation: SessionPrs,
  live?: LiveTurn,
  local?: LocalTurn,
  subagents?: number,
): SessionClaim {
  const state = sessionState({ ...conversation, live, local, subagents })
  if (state === "working") return { state, prTick: false }
  if (state === "resolved" || state === "discarded") return { state, prTick: false }
  // An answer to ask outranks every pull request: the alert glyph is the question, not the arrow.
  if (state === "waiting") return { state, prTick: false }
  const livePrs = (conversation.prs ?? []).filter(prIsLive)
  if (livePrs.some(prChecksWait)) return { state: "waiting", prTick: true }
  if (livePrs.length) return { state: "waiting", prTick: true }
  return { state: "idle", prTick: false }
}

/** What the Code row's round icon wears: the colour that says what is needed. */
export type RowTone = "warning" | "success" | "muted"

/**
 * The colour behind a Code row's glyph, top rule winning (ADR 0046): Discarded grey, Resolved
 * green, then any wait yellow — on the human (the claim waiting without the pull request's arrow)
 * or on a live pull request's checks running or failed, which wait on the watcher — then a draft
 * pull request grey, then an open pull request needing nothing green, then everything else at rest
 * grey. Finished pull requests are in none of it: green names an open pull request literally, and a
 * merged one's checks wait on nothing.
 */
export function rowTone(conversation: Pick<Conversation, "prs">, claim: SessionClaim): RowTone {
  if (claim.state === "discarded") return "muted"
  if (claim.state === "resolved") return "success"
  if (claim.state === "waiting" && !claim.prTick) return "warning"
  const live = (conversation.prs ?? []).filter(prIsLive)
  if (live.some(prChecksWait)) return "warning"
  if (live.some((pr) => pr.state === "draft")) return "muted"
  if (live.some((pr) => pr.state === "open")) return "success"
  return "muted"
}

/**
 * A session's last activity: the newest of its turn's clock, its pull requests' updates and its
 * resolve or discard — derived from moments that already exist (ADR 0046), never stored, so no
 * field joins sync to carry it. The Code row's trailing time is this, and the unread dot measures
 * against it.
 */
export function lastActivityAt(session: SessionActivity): number {
  const settled = Math.max(session.updatedAt, session.resolvedAt ?? 0, session.discardedAt ?? 0)
  return (session.prs ?? []).reduce((newest, pr) => Math.max(newest, pr.at), settled)
}

/**
 * Whether the Code row shows its unread dot: this moment is later than this device's read mark, and
 * a session with no mark — never opened here, or evicted from a full store — has none to be against
 * and draws no dot at all (ADR 0055).
 */
export function isUnread(activity: number, mark: number | undefined): boolean {
  return mark != null && activity > mark
}

/**
 * A thread's state as its card draws it: the session's own ladder, with no session of its own to be
 * resolved or discarded, and a reply that failed saying so only once nothing of the thread's is at
 * work. A subagent still writing is the thread still working, and its failure is the turn that is
 * already over.
 */
export function threadState(thread: ThreadFacts): ThreadState {
  const state = sessionState({
    local: { streaming: thread.streaming, waiting: thread.waiting },
    subagents: thread.subagents,
  })
  if (state === "working" || state === "waiting") return state
  return thread.failed ? "failed" : "idle"
}
