import type { Message } from "@/lib/db"
import { byTimeThenId, place, type Placed } from "./placement.ts"
import type { Thread } from "@/lib/threads"

export type ThreadCards = Placed<Thread>

/** When a card is drawn: the time its thread began. */
export const cardAt = (thread: Thread) => thread.chat.createdAt

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
