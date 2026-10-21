import type { Message } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

/**
 * Where a chat's context was compacted, for its thread to draw a divider on. Kept free of runtime
 * imports so `scripts/test-compactions.mjs` runs it under plain node, like `model-changes.ts`.
 */

/**
 * The ids of the messages to draw a divider above: the first message of the turn each compaction
 * fell in, on the host's clock. Hermes compacts as a turn is being answered — before its reply, or
 * between two of its tool rounds — so the turn it happened in is the first one that runs on the
 * compacted context. One that predates every loaded turn sits above rows this device hasn't loaded,
 * and one the host recorded after the last turn began belongs to that turn, so neither is dropped
 * nor drawn twice: several in one turn are one divider.
 */
export function compactionMarks(messages: Message[], compactions?: Compaction[]): Set<string> {
  const marks = new Set<string>()
  if (!compactions?.length) return marks
  const turns: Message[] = []
  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push(message)
  }
  for (const { at } of compactions) {
    let turn: Message | undefined
    for (const candidate of turns) {
      if (candidate.createdAt > at) break
      turn = candidate
    }
    if (turn) marks.add(turn.id)
  }
  return marks
}
