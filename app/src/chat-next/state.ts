import type { LiveTurn } from "@/lib/db"

import type { Agent } from "./agents"
import type { Queued, RunEvent } from "./api"
import { foldTurns, withArchive, type Part, type Row, type SentFile, type Turn } from "./fold"

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
  /** The rows a compaction archived, once the reader has asked for them; kept across every read. */
  archived?: Row[]
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
      choices: string[]
    }

export type ThreadEvent =
  | { type: "transcript"; rows: Row[]; final?: boolean }
  | { type: "earlier"; rows: Row[] }
  | { type: "sent"; user: string; files?: SentFile[]; at?: number }
  /** A send that never reached the host: the message goes back to the composer, not the thread. */
  | { type: "unsent"; error: string }
  /** A message the host sent somewhere else (triage, ADR 0029): it leaves this thread, unfailed. */
  | { type: "moved" }
  | { type: "attach" }
  | { type: "answered" }
  | { type: "ended" }
  | { type: "agents"; agents: Agent[] }
  | { type: "queue"; items: Queued[]; paused: boolean }
  | { type: "run"; event: RunEvent }
  | { type: "failed"; error: string }

export const initial: ThreadState = { status: "loading", rows: [], running: false }

/** The transcript's turns, the archive folded in where the reader has asked for it. */
export const foldedOf = (rows: Row[], archived?: Row[]) =>
  foldTurns(archived ? withArchive(rows, archived) : rows)

/** The turns the screen draws: the transcript's, with the streamed one laid over the last. */
export function turnsOf(folded: Turn[], live?: LiveTurn): Turn[] {
  if (!live) return folded
  return live.replaces ? [...folded.slice(0, -1), live.turn] : [...folded, live.turn]
}

/** One live event's change to the turn it belongs to; only the part it touches is a new object. */
function live(turn: Turn, event: RunEvent): Turn {
  const { parts } = turn
  const at = typeof event.timestamp === "number" ? event.timestamp * 1000 : undefined
  const last = parts.at(-1)
  const replaceLast = (part: Part): Turn => ({ ...turn, parts: [...parts.slice(0, -1), part] })
  if (event.event === "message.delta" && event.delta) {
    if (last?.kind === "text") return replaceLast({ ...last, text: last.text + event.delta })
    return { ...turn, parts: [...parts, { kind: "text", text: event.delta.trimStart() }] }
  }
  if (event.event === "tool.started" && event.tool) {
    // The host names the call, and the transcript's row for it carries the same id.
    const call = {
      id: event.tool_call_id ?? `live-${parts.length}-${event.seq}`,
      name: event.tool,
      label: event.preview,
      ...(at !== undefined ? { startedAt: at } : {}),
    }
    if (last?.kind === "tools") return replaceLast({ ...last, calls: [...last.calls, call] })
    return { ...turn, parts: [...parts, { kind: "tools", calls: [call] }] }
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
    return { kind: "approval", ...base, command: event.command ?? "", choices: event.choices ?? [] }
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
      const done = foldedOf(event.rows, state.archived).at(-1)?.done
      return {
        status: "ready",
        rows: event.rows,
        archived: state.archived,
        agents: state.agents,
        queue: state.queue,
        running: false,
        // A finished turn waits on nothing, and the end of a followed run settles what it was on.
        waiting: event.final || done ? undefined : state.waiting,
      }
    }
    case "earlier":
      // Drawn by the next read of the transcript, which folds the archive in with the live rows.
      return { ...state, archived: event.rows }
    case "sent":
      return {
        status: "ready",
        rows: state.rows,
        running: true,
        archived: state.archived,
        agents: state.agents,
        queue: state.queue,
        live: {
          turn: {
            user: event.user,
            ...(event.at !== undefined ? { at: event.at } : {}),
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
      const last = turnsOf(foldedOf(state.rows, state.archived), state.live).at(-1)
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
    case "answered":
      // The card goes at once; the host's `*.settled` event confirms it.
      return { ...state, waiting: undefined }
    case "run": {
      const waiting = waitingAfter(state.waiting, event.event)
      const held = state.live
      const turn = held && live(held.turn, event.event)
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
  turnsOf(foldedOf(state.rows, state.archived), state.live)
