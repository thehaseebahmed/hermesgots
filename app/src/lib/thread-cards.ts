import type { Message } from "@/lib/db"
import { place, type Placed } from "./placement.ts"
import type { Thread } from "@/lib/threads"

export type ThreadCards = Placed<Thread>

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
    .sort(
      (a, b) =>
        a.chat.createdAt - b.chat.createdAt ||
        (a.chat.id < b.chat.id ? -1 : a.chat.id > b.chat.id ? 1 : 0),
    )
  return place(messages, started, (thread) => thread.chat.createdAt)
}

export function drawnThreadIds(cards: ThreadCards | undefined): ReadonlySet<string> {
  const drawn = [...(cards ? [...cards.before.values()].flat() : []), ...(cards?.trailing ?? [])]
  return new Set(drawn.map((card) => card.chat.id))
}
