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
 * One facts object and one ladder: a thread's pill is this answer with no session of its own to be
 * resolved or discarded, so the two can't drift.
 *
 * Pure: no clock, and the one value it imports (`pull-state.ts`) is a rule's own — so
 * `scripts/test-session-work.mjs` drives it as a rule.
 */

import { prIsLive } from "./pull-state.ts"
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
 * Where a session stands. A discarded or resolved one says so first, then what wants the user, then
 * anything at work — its own turn, or the subagents it left running.
 */
export function sessionState(facts: SessionFacts): SessionState {
  if (facts.discardedAt) return "discarded"
  if (facts.resolvedAt) return "resolved"
  if (facts.local?.waiting || facts.live === "waiting_for_approval" || facts.planPending)
    return "waiting"
  if (facts.local?.streaming || facts.live === "running" || working(facts.subagents))
    return "working"
  return "idle"
}

/** The slice of a session `sessionGroup` reads: its closure and wait marks, and its pull requests. */
type SessionPrs = Pick<Conversation, "resolvedAt" | "discardedAt" | "planPending" | "prs">

/** Where a Code row's session stands: the group's state, and whether a pull request's arrow claims it. */
export interface SessionClaim {
  state: SessionState
  prTick: boolean
}

/**
 * Where a Code row's session stands, with its pull requests claimed in: the highest claim wins.
 * Closed first, then anything waiting on the user — a question, an approval, a plan, a stall, or a
 * live pull request's checks running or failed, which wait on the watcher rather than the agent
 * (they used to read `working`; a turn running beside them loses to them). A live pull request with
 * nothing wrong still waits for its review and merge, as it always has; `prTick` marks both pull
 * request claims, which is what puts the arrow glyph on the row instead of the alert.
 */
export function sessionGroup(
  conversation: SessionPrs,
  live?: LiveTurn,
  local?: LocalTurn,
  subagents?: number,
): SessionClaim {
  const state = sessionState({ ...conversation, live, local, subagents })
  if (state === "resolved" || state === "discarded") return { state, prTick: false }
  // An answer to ask outranks every pull request: the alert glyph is the question, not the arrow.
  if (state === "waiting") return { state, prTick: false }
  const livePrs = (conversation.prs ?? []).filter(prIsLive)
  if (livePrs.some((pr) => pr.checks === "pending" || pr.checks === "failure"))
    return { state: "waiting", prTick: true }
  if (state === "working") return { state: "working", prTick: false }
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
export function rowTone(conversation: SessionPrs, claim: SessionClaim): RowTone {
  if (claim.state === "discarded") return "muted"
  if (claim.state === "resolved") return "success"
  if (claim.state === "waiting" && !claim.prTick) return "warning"
  const live = (conversation.prs ?? []).filter(prIsLive)
  if (live.some((pr) => pr.checks === "pending" || pr.checks === "failure")) return "warning"
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
export function lastActivityAt(
  session: Pick<Conversation, "updatedAt" | "resolvedAt" | "discardedAt" | "prs">,
): number {
  const settled = Math.max(session.updatedAt, session.resolvedAt ?? 0, session.discardedAt ?? 0)
  return (session.prs ?? []).reduce((newest, pr) => Math.max(newest, pr.at), settled)
}

/**
 * Whether the Code row shows its unread dot: the session's last activity is newer than this
 * device's read mark — and a session this device has never opened has no mark, so it is unread.
 */
export function isUnread(
  session: Pick<Conversation, "updatedAt" | "resolvedAt" | "discardedAt" | "prs">,
  mark: number | undefined,
): boolean {
  return lastActivityAt(session) > (mark ?? 0)
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
