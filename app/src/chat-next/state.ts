import type { Agent } from "./agents"
import type { RunEvent } from "./api"
import { foldTurns, withArchive, type Part, type Row, type Turn } from "./fold"

export interface ThreadState {
  status: "loading" | "ready" | "failed"
  turns: Turn[]
  /** The children the session delegated to, as the plugin last listed them; none before it has. */
  agents?: Agent[]
  /** The rows a compaction archived, once the reader has asked for them; kept across every read. */
  archived?: Row[]
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
  | { type: "sent"; user: string }
  | { type: "attach" }
  | { type: "answered" }
  | { type: "ended" }
  | { type: "agents"; agents: Agent[] }
  | { type: "run"; event: RunEvent }
  | { type: "failed"; error: string }

export const initial: ThreadState = { status: "loading", turns: [], running: false }

/** One live event's change to the turn it belongs to. */
function live(turn: Turn, event: RunEvent): Turn {
  const parts: Part[] = turn.parts.map((part) =>
    part.kind === "tools" ? { ...part, calls: part.calls.map((call) => ({ ...call })) } : part,
  )
  const last = parts.at(-1)
  if (event.event === "message.delta" && event.delta) {
    if (last?.kind === "text") parts[parts.length - 1] = { ...last, text: last.text + event.delta }
    else parts.push({ kind: "text", text: event.delta.trimStart() })
  } else if (event.event === "tool.started" && event.tool) {
    // The host names the call, and the transcript's row for it carries the same id.
    const call = {
      id: event.tool_call_id ?? `live-${parts.length}-${event.seq}`,
      name: event.tool,
      label: event.preview,
    }
    if (last?.kind === "tools") last.calls.push(call)
    else parts.push({ kind: "tools", calls: [call] })
  } else if (event.event === "tool.completed" && event.tool_call_id) {
    const call = parts
      .flatMap((part) => (part.kind === "tools" ? part.calls : []))
      .find((one) => one.id === event.tool_call_id)
    if (call) call.result = event.preview ?? ""
  }
  return { ...turn, parts }
}

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
      const turns = foldTurns(state.archived ? withArchive(event.rows, state.archived) : event.rows)
      return {
        status: "ready",
        turns,
        archived: state.archived,
        agents: state.agents,
        running: false,
        // A finished turn waits on nothing, and the end of a followed run settles what it was on.
        waiting: event.final || turns.at(-1)?.done ? undefined : state.waiting,
      }
    }
    case "earlier":
      // Drawn by the next read of the transcript, which folds the archive in with the live rows.
      return { ...state, archived: event.rows }
    case "sent":
      return {
        status: "ready",
        running: true,
        archived: state.archived,
        agents: state.agents,
        turns: [...state.turns, { user: event.user, parts: [], done: false, delivered: [] }],
      }
    case "attach":
      // The run's events are replayed from its start, so the turn, and what it waits on, are drawn
      // again from nothing.
      return {
        ...state,
        running: true,
        waiting: undefined,
        turns: state.turns.map((turn, at) =>
          at === state.turns.length - 1 ? { ...turn, parts: [], done: false } : turn,
        ),
      }
    case "agents":
      return JSON.stringify(state.agents) === JSON.stringify(event.agents)
        ? state
        : { ...state, agents: event.agents }
    case "ended":
      // The stream is over, however it ended, so the thread is no longer held by it. What the turn
      // was comes from the transcript, which a later read may supply if the one for this end was
      // superseded.
      return { ...state, running: false }
    case "answered":
      // The card goes at once; the host's `*.settled` event confirms it.
      return { ...state, waiting: undefined }
    case "run":
      return {
        ...state,
        waiting: waitingAfter(state.waiting, event.event),
        turns: state.turns.map((turn, at) =>
          at === state.turns.length - 1 ? live(turn, event.event) : turn,
        ),
      }
    case "failed":
      return { ...state, status: "failed", running: false, waiting: undefined, error: event.error }
  }
}
