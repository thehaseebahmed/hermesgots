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

/**
 * When a marker is drawn: the moment the message was sent, which the ask carried to the host and the
 * host recorded on the move (ADR 0089). Nothing the host did afterwards moves it.
 */
export const moveAt = (move: Move) => move.at

export function moveMarks(
  messages: Message[],
  moves: Move[] | undefined,
  threadsDrawnAsCards: ReadonlySet<string>,
): MoveMarks {
  const marked = (moves ?? []).filter((move) => {
    const opened = openedThread(move)
    return !move.undone && !(opened && threadsDrawnAsCards.has(opened))
  })
  return place(messages, marked, moveAt)
}
