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
 * end of the thread while nothing has. One that predates every loaded message sits above rows this
 * device hasn't loaded, so it marks nothing; several in one gap are one divider, the first's.
 */
export function compactionMarks(messages: Message[], compactions?: Compaction[]): CompactionMarks {
  const marks: CompactionMarks = { before: new Map() }
  const first = messages[0]
  if (!first || !compactions?.length) return marks
  for (const compaction of compactions) {
    if (first.createdAt > compaction.at) continue
    const next = messages.find((message) => message.createdAt > compaction.at)
    if (!next) marks.trailing ??= compaction
    else if (!marks.before.has(next.id)) marks.before.set(next.id, compaction)
  }
  return marks
}
