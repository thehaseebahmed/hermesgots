import type { Compaction, Move } from "@/lib/hermes"
import type { Thread } from "@/lib/threads"

import { compactionAt } from "./compactions.ts"
import { byTimeThenId } from "./placement.ts"
import { cardAt } from "./thread-cards.ts"
import { moveAt } from "./move-marks.ts"

/**
 * A thing that stands where Main's messages run out, with the clock it is drawn at: a thread's card,
 * the marker of a message the host moved, or the divider of a compaction.
 */
export type TailItem =
  | { kind: "card"; at: number; thread: Thread }
  | { kind: "move"; at: number; move: Move }
  | { kind: "compaction"; at: number; compaction: Compaction }

const idOf = (item: TailItem) =>
  item.kind === "card"
    ? item.thread.chat.id
    : item.kind === "move"
      ? item.move.id
      : `compaction-${compactionAt(item.compaction)}`

/**
 * The end of a Main's flow, as one timeline. A card is placed by the time its thread began, a marker
 * and a divider by the host's own record, and each producer hands back what no message follows;
 * stacking those lists one after another is what puts every card above every marker — a move made
 * this morning drawn under a card begun yesterday, which is a thread's order read off the wrong
 * clock. Ties keep a total order by id, so nothing swaps places between renders.
 */
export function mainTail({
  cards = [],
  moves = [],
  compaction,
}: {
  /** The threads no message follows, from `threadCards`' own trailing. */
  cards?: readonly Thread[]
  /** The moves no message follows, from `moveMarks`' own trailing. */
  moves?: readonly Move[]
  /** A compaction made after everything Main shows, from `compactionMarks`' trailing. */
  compaction?: Compaction
}): TailItem[] {
  const items: TailItem[] = [
    ...cards.map((thread): TailItem => ({ kind: "card", at: cardAt(thread), thread })),
    ...moves.map((move): TailItem => ({ kind: "move", at: moveAt(move), move })),
  ]
  if (compaction) items.push({ kind: "compaction", at: compactionAt(compaction), compaction })
  return items.sort(byTimeThenId((item) => item.at, idOf))
}
