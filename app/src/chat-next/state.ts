import type { RunEvent } from "./api"
import { foldTurns, type Part, type Row, type Turn } from "./fold"

export interface ThreadState {
  status: "loading" | "ready" | "failed"
  turns: Turn[]
  /** This device has a turn running; while it does, what the host's transcript says waits. */
  running: boolean
  error?: string
}

export type ThreadEvent =
  | { type: "transcript"; rows: Row[]; final?: boolean }
  | { type: "sent"; user: string }
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
    const call = { id: `live-${parts.length}-${Math.random()}`, name: event.tool }
    if (last?.kind === "tools") last.calls.push(call)
    else parts.push({ kind: "tools", calls: [call] })
  } else if (event.event === "tool.completed" && event.tool) {
    // The events carry no call id, so a result belongs to the oldest call of that tool still open.
    const open = parts
      .flatMap((part) => (part.kind === "tools" ? part.calls : []))
      .find((call) => call.name === event.tool && call.result === undefined)
    if (open) open.result = event.preview ?? ""
  }
  return { ...turn, parts }
}

/** The one place the thread changes: what is on screen is this state and nothing else. */
export function reduce(state: ThreadState, event: ThreadEvent): ThreadState {
  switch (event.type) {
    case "transcript":
      if (state.running && !event.final) return state
      return { status: "ready", turns: foldTurns(event.rows), running: false }
    case "sent":
      return {
        status: "ready",
        running: true,
        turns: [...state.turns, { user: event.user, parts: [] }],
      }
    case "run":
      return {
        ...state,
        turns: state.turns.map((turn, at) =>
          at === state.turns.length - 1 ? live(turn, event.event) : turn,
        ),
      }
    case "failed":
      return { ...state, status: "failed", running: false, error: event.error }
  }
}
