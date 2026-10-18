import type { Message } from "@/lib/db"
import type { ModelChange } from "@/lib/hermes"
import { sameModel } from "./model-match.ts"

/**
 * Where a chat's model changed, for its thread to draw a divider on. Kept free of every runtime
 * import so `scripts/test-model-changes.mjs` runs it under plain node, like `model-sort.ts` — the
 * model-identity rule it needs lives in `model-match.ts` for the same reason.
 */

/** One turn of a thread, as the placement reads it. */
interface Turn {
  /** The first message the thread shows of the turn: what a divider above the turn sits above. */
  first: { id: string; createdAt: number }
  /** The model this device started the turn with, which only a reply carries. */
  sent?: string
  /** The turn's reply is still being written: its own call hasn't run, so the host has said nothing. */
  running?: boolean
}

/** A thread's turns in order: one opens at its user message, or at its reply when the user row isn't loaded. */
function readTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  for (const message of messages) {
    const open = turns[turns.length - 1]
    if (message.role === "user" || !open) {
      // A reply whose user row wasn't loaded opens the turn, and is its own device's pick.
      turns.push({
        first: message,
        ...(message.model ? { sent: message.model } : {}),
        ...(message.status === "streaming" ? { running: true } : {}),
      })
      continue
    }
    if (message.model) open.sent = message.model
    if (message.status === "streaming") open.running = true
  }
  return turns
}

/**
 * The model a turn ran on. The host's record wins where it covers the turn: the change its own
 * first call fired, else the model in effect when the turn opened. Where the record hasn't spoken for
 * the turn — the one being written, or the newest one, whose call may not be recorded yet — this
 * device's own pick stands, as it does in the pill. Failing all that, the model this device sent it
 * with. `end` is where the turn's call is known to have run by — the next turn's opening, or unbounded
 * for the turn still at the end of the thread.
 */
function turnModel(
  turn: Turn,
  changes: ModelChange[] | undefined,
  end: number,
  latest: boolean,
): ModelChange | undefined {
  const recorded = changes ?? []
  const start = turn.first.createdAt
  // A change fired while the turn ran answered it, so it lands here; one that lands later in the
  // same turn is the next turn's own call, and shows there instead. The rows are in order, so the
  // first one inside the turn is the one to read.
  const fired = recorded.find((change) => change.at >= start && change.at < end)
  if (fired) return fired
  let carried: ModelChange | undefined
  for (const change of recorded) {
    if (change.at >= start) break
    carried = change
  }
  // The record named nothing inside this turn, which for the newest one means the host may simply not
  // have recorded it yet: the pick is the newer word on what it runs, and the record's own row for the
  // turn replaces it the moment it lands. A turn with a newer one below it has been answered for, and
  // there the carried model stands — no row inside it means the pick never reached the host at all.
  if (turn.sent && (turn.running || latest)) return { at: start, model: turn.sent }
  if (carried) return carried
  return turn.sent ? { at: start, model: turn.sent } : undefined
}

/**
 * The dividers to draw, as a map of message id to the model to name above it: the first message of
 * each turn whose known model differs from the previous known one. A turn neither the host nor a
 * pick covers stays unknown, and unknown never counts as different — so no divider is ever wrong.
 */
export function modelChanges(messages: Message[], changes?: ModelChange[]): Map<string, string> {
  const dividers = new Map<string, string>()
  const turns = readTurns(messages)
  let carried: string | undefined
  for (const [index, turn] of turns.entries()) {
    const end = turns[index + 1]?.first.createdAt ?? Infinity
    const model = turnModel(turn, changes, end, index === turns.length - 1)?.model
    if (model && carried && !sameModel(carried, model)) dividers.set(turn.first.id, model)
    if (model) carried = model
  }
  return dividers
}

/**
 * Whether the last turn of a thread is one the app can't name a model for — the case a read of the
 * host's record fixes, and the only one. The next turn can be divided from this one and nothing else,
 * so a chat asks its host for the record as a turn opens where this is true, rather than leaving the
 * switch unknown until the turn it started ends.
 */
export function unknownLastTurn(messages: Message[], changes?: ModelChange[]): boolean {
  const last = readTurns(messages).at(-1)
  return last !== undefined && turnModel(last, changes, Infinity, true) === undefined
}
