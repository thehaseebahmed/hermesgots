import type { LiveTurn, MessageStats } from "@/lib/db"
import { measureReply } from "@/lib/reply-stats"

import type { Agent } from "./agents"
import type { Queued, RunEvent } from "./api"
import { overlay, prepend } from "./pages.ts"
import {
  foldTurns,
  withArchive,
  withoutRepeatedFailures,
  type Part,
  type Row,
  type SentFile,
  type Turn,
} from "./fold"

/**
 * A thread as the page knows it. The rows, the archive, the subagents and the streamed turn are what
 * the chat says, and are kept on the device; the rest is what this page is doing, and is not
 * (ADR 0065).
 */
export interface ThreadState {
  status: "loading" | "ready" | "failed"
  /** The transcript as the host last gave it. */
  rows: Row[]
  /** The children the session delegated to, as the plugin last listed them; none before it has. */
  agents?: Agent[]
  /**
   * The rows above are the newest ones of a transcript whose older rows are not all read: the page
   * reads them on, and a read that joins what is held leaves it as it was.
   */
  partial?: boolean
  /** The rows a compaction archived, once the reader has asked for them; kept across every read. */
  archived?: Row[]
  /** What the turns this device watched cost, by the id of the row that opened each. */
  stats?: Record<string, MessageStats>
  /** What the plugin holds for the session, drawn after the thread; none before it has said. */
  queue?: { items: Queued[]; paused: boolean }
  /** The turn this device is streaming, drawn over the transcript's until the host's replaces it. */
  live?: LiveTurn
  /** This device has a turn running; while it does, what the host's transcript says waits. */
  running: boolean
  /** What the run is held up on, until the user's answer or someone else's takes it away. */
  waiting?: Waiting
  error?: string
}

/** A prompt the run is held up on. Each question is a prompt of its own, one at a time. */
export type Waiting =
  | {
      kind: "question"
      run: string
      promptId: string
      generation: number
      question: string
      choices: string[]
      multiSelect: boolean
    }
  | {
      kind: "approval"
      run: string
      promptId: string
      generation: number
      command: string
      description?: string
      choices: string[]
    }

export type ThreadEvent =
  /**
   * `more` says older rows are left unread; where it is left out they are as they were. With `joined`
   * the rows are only the newest ones, laid over the rows held from where they start.
   */
  | { type: "transcript"; rows: Row[]; final?: boolean; more?: boolean; joined?: boolean }
  /** An older page of the transcript, to go above the rows held; `last` is the start of the chat. */
  | { type: "older"; rows: Row[]; last: boolean }
  | { type: "earlier"; rows: Row[] }
  | { type: "sent"; user: string; files?: SentFile[]; at?: number }
  /** A send that never reached the host: the message goes back to the composer, not the thread. */
  | { type: "unsent"; error: string }
  /** A message the host sent somewhere else (triage, ADR 0029): it leaves this thread, unfailed. */
  | { type: "moved" }
  | { type: "attach" }
  /** The card goes; `result` is what the answer makes the question's call return, where it asked one. */
  | { type: "answered"; result?: string }
  | { type: "ended" }
  | { type: "agents"; agents: Agent[] }
  | { type: "queue"; items: Queued[]; paused: boolean }
  /** `at` is this device's clock as the event arrived, which a turn it sent is timed by. */
  | { type: "run"; event: RunEvent; at?: number }
  | { type: "failed"; error: string }

export const initial: ThreadState = { status: "loading", rows: [], running: false }

/**
 * The answer the app just gave, written onto the call the question was asked by. Hermes's served
 * turn sends `tool.completed` with no result, so nothing else fills it in: without this the
 * thread's card would read "No answer", with Ask again, until the transcript's own row for the
 * call lands at the end of the turn.
 */
function withClarifyResult(turn: Turn, result: string): Turn {
  // The served turn's completion sets an empty preview rather than leaving it out, so a call that
  // carries nothing is one still waiting for its answer.
  const asked = (call: { name: string; result?: string }) => call.name === "clarify" && !call.result
  const at = turn.parts.findLastIndex(
    (part) => part.kind === "tools" && part.calls.some((call) => asked(call)),
  )
  const part = turn.parts[at]
  if (part?.kind !== "tools") return turn
  const callAt = part.calls.findLastIndex((call) => asked(call))
  const calls = part.calls.with(callAt, { ...part.calls[callAt], result })
  return { ...turn, parts: turn.parts.with(at, { ...part, calls }) }
}

/** The transcript's turns, the archive folded in where the reader has asked for it. */
export const foldedOf = (rows: Row[], archived?: Row[], partial?: boolean) =>
  foldTurns(archived ? withArchive(rows, archived) : rows, Boolean(partial) && !archived)

/** The turns the screen draws: the transcript's, with the streamed one laid over the last. */
export function turnsOf(folded: Turn[], live?: LiveTurn): Turn[] {
  if (!live) return folded
  return withoutRepeatedFailures(
    live.replaces ? [...folded.slice(0, -1), live.turn] : [...folded, live.turn],
  )
}

/** One live event's change to the turn it belongs to; only the part it touches is a new object. */
function live(turn: Turn, event: RunEvent, now?: number): Turn {
  const { parts } = turn
  const at = typeof event.timestamp === "number" ? event.timestamp * 1000 : undefined
  const last = parts.at(-1)
  const replaceLast = (part: Part): Turn => ({ ...turn, parts: [...parts.slice(0, -1), part] })
  // The first word of a turn this device sent starts the clock its speed is read by.
  const stamp = (next: Turn): Turn =>
    next.timing && next.timing.firstTokenAt === undefined && now !== undefined
      ? { ...next, timing: { ...next.timing, firstTokenAt: now } }
      : next
  if (event.event === "reasoning.available" && event.text) {
    const pendingThought = turn.pendingThought
      ? `${turn.pendingThought}\n\n${event.text}`
      : event.text
    return { ...turn, pendingThought }
  }
  // An interim line is words the agent said between calls, which the deltas did not carry when the
  // provider does not stream.
  const words =
    event.event === "message.delta"
      ? event.delta
      : event.event === "message.interim" && event.text && !event.already_streamed
        ? `${event.text}\n\n`
        : undefined
  if (words) {
    const { pendingThought: thought, ...rest } = turn
    if (last?.kind === "text" && !thought)
      return stamp(replaceLast({ ...last, text: last.text + words }))
    return stamp({
      ...rest,
      parts: [...parts, { kind: "text", text: words.trimStart(), ...(thought ? { thought } : {}) }],
    })
  }
  if (event.event === "tool.started" && event.tool) {
    // The host names the call, and the transcript's row for it carries the same id.
    const { pendingThought: thought, ...rest } = turn
    const call = {
      id: event.tool_call_id ?? `live-${parts.length}-${event.seq}`,
      name: event.tool,
      label: event.preview,
      ...(at !== undefined ? { startedAt: at } : {}),
      ...(thought ? { thought } : {}),
    }
    if (last?.kind === "tools")
      return { ...rest, parts: [...parts.slice(0, -1), { ...last, calls: [...last.calls, call] }] }
    return { ...rest, parts: [...parts, { kind: "tools", calls: [call] }] }
  }
  if (event.event === "tool.completed" && event.tool_call_id) {
    const at = parts.findIndex(
      (part) => part.kind === "tools" && part.calls.some((one) => one.id === event.tool_call_id),
    )
    const part = parts[at]
    if (part?.kind !== "tools") return turn
    const calls = part.calls.map((one) =>
      one.id === event.tool_call_id
        ? {
            ...one,
            result: event.preview ?? "",
            ...(at !== undefined ? { endedAt: at } : {}),
          }
        : one,
    )
    return { ...turn, parts: parts.with(at, { ...part, calls }) }
  }
  // The end of a run this device watched from its start says what the reply cost.
  if (event.event === "run.completed" && turn.timing && now !== undefined) {
    const text = parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("")
    if (text || event.usage)
      return {
        ...turn,
        stats: measureReply({
          text,
          toolsUsed: parts.some((part) => part.kind === "tools"),
          counted: event.usage?.output_tokens,
          promptTokens: event.usage?.input_tokens,
          ...turn.timing,
          endedAt: now,
        }),
      }
  }
  return turn
}

const sameAgents = (a: Agent[] | undefined, b: Agent[]) =>
  a?.length === b.length &&
  a.every(
    (one, at) =>
      one.id === b[at].id &&
      one.status === b[at].status &&
      one.goal === b[at].goal &&
      one.ended_at === b[at].ended_at &&
      one.tool_calls === b[at].tool_calls,
  )

const sameQueue = (a: ThreadState["queue"], b: NonNullable<ThreadState["queue"]>) =>
  a?.paused === b.paused &&
  a.items.length === b.items.length &&
  a.items.every(
    (one, at) =>
      one.id === b.items[at].id &&
      one.text === b.items[at].text &&
      one.error === b.items[at].error &&
      one.files.join() === b.items[at].files.join(),
  )

const SETTLED = ["approval.settled", "clarify.settled"]
const ENDINGS = ["run.completed", "run.failed", "run.cancelled", "run.interrupted"]

/** What a live event says the run is waiting on, if it says anything. */
function waitingAfter(waiting: Waiting | undefined, event: RunEvent): Waiting | undefined {
  const base = {
    run: event.run_id ?? "",
    promptId: event.prompt_id ?? "",
    generation: event.execution_generation ?? 0,
  }
  if (event.event === "clarify.request" && event.prompt_id)
    return {
      kind: "question",
      ...base,
      question: event.question ?? "",
      choices: event.choices ?? [],
      multiSelect: Boolean(event.multi_select),
    }
  if (event.event === "approval.request" && event.prompt_id)
    return {
      kind: "approval",
      ...base,
      command: event.command ?? "",
      ...(event.description ? { description: event.description } : {}),
      choices: event.choices ?? [],
    }
  // A prompt that settles is the one on screen, or an old one the screen has moved on from.
  if (SETTLED.includes(event.event))
    return event.prompt_id === waiting?.promptId ? undefined : waiting
  return ENDINGS.includes(event.event) ? undefined : waiting
}

/** The one place the thread changes: what is on screen is this state and nothing else. */
export function reduce(state: ThreadState, event: ThreadEvent): ThreadState {
  switch (event.type) {
    case "transcript": {
      if (state.running && !event.final) return state
      const rows = event.joined ? overlay(state.rows, event.rows) : event.rows
      if (!rows) return state
      const partial = event.more ?? state.partial
      const last = foldedOf(rows, state.archived, partial).at(-1)
      const done = last?.done
      // What the turn this device watched cost goes with the row that opened it, which the
      // transcript has now written.
      const measured = state.live?.turn.stats
      // The turn is the one the transcript just gained: a repeated prompt read before the host has
      // written the new request would otherwise take the previous turn's row.
      const stats =
        measured &&
        last?.row !== undefined &&
        last.user === state.live?.turn.user &&
        last.row !== foldedOf(state.rows, state.archived, state.partial).at(-1)?.row
          ? { ...state.stats, [last.row]: measured }
          : state.stats
      return {
        status: "ready",
        rows,
        ...(partial ? { partial } : {}),
        archived: state.archived,
        agents: state.agents,
        queue: state.queue,
        stats,
        running: false,
        // A finished turn waits on nothing, and the end of a followed run settles what it was on.
        waiting: event.final || done ? undefined : state.waiting,
      }
    }
    case "older": {
      // A page that lands after the chat was made whole (a read of all of it) has nothing to add.
      if (!state.partial) return state
      // Rows above the ones held change nothing of what the device is doing: no turn, run or wait.
      const rows = prepend(state.rows, event.rows)
      const partial = event.last ? undefined : true
      if (rows === state.rows && partial === state.partial) return state
      return { ...state, rows, partial }
    }
    case "earlier":
      // Drawn by the next read of the transcript, which folds the archive in with the live rows.
      return { ...state, archived: event.rows }
    case "sent":
      return {
        status: "ready",
        rows: state.rows,
        partial: state.partial,
        running: true,
        archived: state.archived,
        agents: state.agents,
        queue: state.queue,
        stats: state.stats,
        live: {
          turn: {
            user: event.user,
            ...(event.at !== undefined ? { at: event.at, timing: { startedAt: event.at } } : {}),
            ...(event.files?.length ? { files: event.files } : {}),
            parts: [],
            done: false,
            delivered: [],
          },
          replaces: false,
        },
      }
    case "unsent":
      return { ...state, live: undefined, running: false, status: "failed", error: event.error }
    case "moved":
      return { ...state, live: undefined, running: false }
    case "attach": {
      // The run's events are replayed from its start, so the turn, and what it waits on, are drawn
      // again from nothing.
      const last = turnsOf(foldedOf(state.rows, state.archived, state.partial), state.live).at(-1)
      return {
        ...state,
        running: true,
        waiting: undefined,
        live: last ? { turn: { ...last, parts: [], done: false }, replaces: true } : undefined,
      }
    }
    case "queue": {
      const next = { items: event.items, paused: event.paused }
      return sameQueue(state.queue, next) ? state : { ...state, queue: next }
    }
    case "agents":
      return sameAgents(state.agents, event.agents) ? state : { ...state, agents: event.agents }
    case "ended":
      // The stream is over, however it ended, so the thread is no longer held by it. What the turn
      // was comes from the transcript, which a later read may supply if the one for this end was
      // superseded.
      return { ...state, running: false }
    case "answered": {
      // The card goes at once; the host's `*.settled` event confirms it. A question's call reads
      // the answer from here until the transcript's own result reaches it.
      const given =
        state.live && event.result ? withClarifyResult(state.live.turn, event.result) : undefined
      const live =
        state.live && given && given !== state.live.turn
          ? { ...state.live, turn: given }
          : state.live
      return { ...state, waiting: undefined, ...(live ? { live } : {}) }
    }
    case "run": {
      const waiting = waitingAfter(state.waiting, event.event)
      const held = state.live
      const turn = held && live(held.turn, event.event, event.at)
      const moved = held && turn && turn !== held.turn ? { ...held, turn } : held
      if (waiting === state.waiting && moved === held) return state
      return { ...state, waiting, live: moved }
    }
    case "failed":
      return { ...state, status: "failed", running: false, waiting: undefined, error: event.error }
  }
}

/** The turns a state draws. */
export const threadTurns = (state: ThreadState) =>
  turnsOf(foldedOf(state.rows, state.archived, state.partial), state.live)
