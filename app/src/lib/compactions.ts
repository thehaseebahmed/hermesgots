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
 * can load is where its compaction happened. Several in one gap are one divider, the first's. One a
 * reply already draws inside itself, at its seam, draws nothing here — the placement is this one
 * function's to make, wherever the divider ends up.
 */
export function compactionMarks(messages: Message[], compactions?: Compaction[]): CompactionMarks {
  const marks: CompactionMarks = { before: new Map() }
  if (!messages.length || !compactions?.length) return marks
  const inside = new Set(
    messages.flatMap((message) =>
      (message.seams ?? []).map((seam) => compactionOf(seam, compactions)),
    ),
  )
  // The host's own time where the row kept it: `createdAt` is this device's, and a catch-up can
  // floor it forward past the mark, one row the wrong side of the line.
  const at = (message: Message) => message.hermesAt ?? message.createdAt
  for (const compaction of compactions) {
    if (inside.has(compaction)) continue
    const next = messages.find((message) => at(message) > compaction.at)
    if (!next) marks.trailing ??= compaction
    else if (!marks.before.has(next.id)) marks.before.set(next.id, compaction)
  }
  return marks
}

/**
 * The host's record of the compaction a reply's seam marks: by the summary's row where the plugin
 * named one, else by the summary's own time, which a plugin older than its row field still marks.
 * Both sides round that row's timestamp to the millisecond, so the times are equal or unrelated; a
 * rotation's mark is the parent's end, which no seam sits on.
 */
export function compactionOf(
  seam: { row: number; at: number },
  compactions?: Compaction[],
): Compaction | undefined {
  return (
    compactions?.find((one) => one.row === seam.row) ??
    compactions?.find((one) => one.row === undefined && one.at === seam.at)
  )
}
