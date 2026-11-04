import type { Message } from "@/lib/db"
import type { Move } from "@/lib/hermes"
import { byTimeThenId, place, type Placed } from "./placement.ts"
import type { Thread } from "@/lib/threads"

export type ThreadCards = Placed<Thread>

/**
 * When a card is drawn: the time the thread's opener was sent, as the host recorded it when it made
 * the thread, falling back to the record's own creation time for a thread nothing named an opener
 * for (ADR 0089, ADR 0090).
 */
export const cardAt = (thread: Thread) => thread.chat.openerAt ?? thread.chat.createdAt

/**
 * The words in a thread's own bubble: the message triage moved out of Main when it opened this
 * thread, else the first message this device holds in it, else the opener the host recorded when it
 * made the thread (ADR 0090). Nothing when there is none of those — the thread's name is the card's
 * line and never stands in for a message nobody holds (ADR 0082).
 */
export function openerWords(thread: Pick<Thread, "opener">, move?: Pick<Move, "text">) {
  return move?.text ?? thread.opener
}

/**
 * Two threads begun at the same moment keep a total order by id, so a card never swaps places
 * between renders.
 */
export function threadCards(
  messages: readonly Message[],
  threads: readonly Thread[] | undefined,
): ThreadCards {
  const started = (threads ?? [])
    .filter((thread) => !thread.chat.main)
    .sort(byTimeThenId(cardAt, (thread) => thread.chat.id))
  return place(messages, started, cardAt)
}

export function drawnThreadIds(cards: ThreadCards | undefined): ReadonlySet<string> {
  const drawn = [...(cards ? [...cards.before.values()].flat() : []), ...(cards?.trailing ?? [])]
  return new Set(drawn.map((card) => card.chat.id))
}
