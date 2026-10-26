import type { Message } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

/**
 * Where a chat's context was compacted, for its thread to draw a divider on. Kept free of runtime
 * imports so `scripts/test-compactions.mjs` runs it under plain node, like `model-changes.ts`.
 */

export interface CompactionMarks {
  /** The messages to draw a divider above, each with the compaction it marks. */
  before: Map<string, Compaction>
  /** A compaction came after everything the thread shows, so its divider closes the thread. */
  trailing?: Compaction
}

/**
 * Each compaction sits above the first message written after it, on the host's clock. That is exact
 * for one made between turns, and for one made as a turn opens it lands between the user's message and
 * the reply; one made while a reply runs lands after that reply, above whatever comes next, or at the
 * end of the thread while nothing has. One that predates every message this device holds stands above
 * the first of them: Hermes keeps the rows it took away off the transcript, so the top of what a device
 * can load is where its compaction happened. Several in one gap are one divider, the first's.
 */
export function compactionMarks(messages: Message[], compactions?: Compaction[]): CompactionMarks {
  const marks: CompactionMarks = { before: new Map() }
  if (!messages.length || !compactions?.length) return marks
  for (const compaction of compactions) {
    const next = messages.find((message) => message.createdAt > compaction.at)
    if (!next) marks.trailing ??= compaction
    else if (!marks.before.has(next.id)) marks.before.set(next.id, compaction)
  }
  return marks
}
