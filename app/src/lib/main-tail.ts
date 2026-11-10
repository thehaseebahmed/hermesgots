import type { Move } from "@/lib/hermes"
import type { Thread } from "@/lib/threads"

import type { CompactionEntry } from "./chat-flow.ts"
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
  | CompactionEntry

/** An item's id: how the order keeps two items at one moment apart, and how its row is keyed. */
export const tailId = (item: TailItem) =>
  item.kind === "card"
    ? item.thread.chat.id
    : item.kind === "move"
      ? item.move.id
      : `compaction-${compactionAt(item.compaction)}`

/**
 * The items a set of producers hands over, each carrying its own clock: a card the time its thread
 * began (`cardAt`), a marker the time the reader sent the message (`moveAt`). A compaction's divider
 * is `chatFlow`'s to place above its message, and joins these here as an item like any other, so a
 * fourth producer, or a clock that reads differently, is a change in one place (ADR 0097).
 */
export function tailItems({
  cards,
  moves,
}: {
  cards?: readonly Thread[]
  moves?: readonly Move[]
}): TailItem[] {
  return [
    ...(cards ?? []).map((thread): TailItem => ({ kind: "card", at: cardAt(thread), thread })),
    ...(moves ?? []).map((move): TailItem => ({ kind: "move", at: moveAt(move), move })),
  ]
}

/**
 * The one order a flow draws its items in — at the foot of Main and in the gap above one of its
 * messages alike (ADR 0097).
 */
export const orderTail = (items: readonly TailItem[]): TailItem[] =>
  [...items].sort(byTimeThenId((item) => item.at, tailId))

/**
 * What no message follows in Main's flow: its cards and the markers of the moves, by their own times.
 * A compaction draws no divider there: a divider stands between two messages of the thread, so one
 * the host made after everything written has none to stand between (see `compactionMarks`).
 */
export function mainTail({
  cards,
  moves,
}: {
  /** The threads no message follows, from `threadCards`' own trailing. */
  cards?: readonly Thread[]
  /** The moves no message follows, from `moveMarks`' own trailing. */
  moves?: readonly Move[]
}): TailItem[] {
  return orderTail(tailItems({ cards, moves }))
}
