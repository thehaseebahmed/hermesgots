import type { Message } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

/**
 * Where a chat's context was compacted, for its thread to draw a divider on. Kept free of runtime
 * imports so `scripts/test-compactions.mjs` runs it under plain node, like `model-changes.ts`.
 */

export interface CompactionMarks {
  /** The ids of the messages to draw a divider above. */
  before: Set<string>
  /** A compaction came after everything the thread shows, so its divider closes the thread. */
  trailing: boolean
}

/**
 * Each compaction sits above the first message written after it, on the host's clock. That is exact
 * for one made between turns, and for one made as a turn opens it lands between the user's message and
 * the reply; one made while a reply runs lands after that reply, above whatever comes next, or at the
 * end of the thread while nothing has. One that predates every loaded message sits above rows this
 * device hasn't loaded, so it marks nothing; several in one gap are one divider.
 */
export function compactionMarks(messages: Message[], compactions?: Compaction[]): CompactionMarks {
  const marks: CompactionMarks = { before: new Set(), trailing: false }
  const first = messages[0]
  if (!first || !compactions?.length) return marks
  for (const { at } of compactions) {
    if (first.createdAt > at) continue
    const next = messages.find((message) => message.createdAt > at)
    if (next) marks.before.add(next.id)
    else marks.trailing = true
  }
  return marks
}
