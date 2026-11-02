import type { Message } from "@/lib/db"
import type { Move } from "@/lib/hermes"
import { place, type Placed } from "./placement.ts"

export type MoveMarks = Placed<Move>

/**
 * The thread the host opened for a move's message, when it opened one and the move isn't undone.
 * That message is drawn by the thread's card, which carries the move's own Undo.
 */
export function openedThread(move: Move): string | undefined {
  return move.new && !move.undone ? move.threadId : undefined
}

/** The millisecond past a move a later turn is stamped, since `place` draws above the first message after it. */
const MOVE_GAP = 1

/**
 * The time a turn typed now must sort after: the newest move the host recorded, whose clock can run
 * ahead of this device's — a turn stamped before it is placed above that move, so its marker draws at
 * the end of the flow instead of where the message went.
 */
export function movesFloor(moves: Move[] | undefined, now: number): number {
  return (moves ?? []).reduce(
    (at, move) => (move.undone ? at : Math.max(at, move.at + MOVE_GAP)),
    now,
  )
}

export function moveMarks(
  messages: Message[],
  moves: Move[] | undefined,
  threadsDrawnAsCards: ReadonlySet<string>,
): MoveMarks {
  const marked = (moves ?? []).filter((move) => {
    const opened = openedThread(move)
    return !move.undone && !(opened && threadsDrawnAsCards.has(opened))
  })
  return place(messages, marked, (move) => move.at)
}
