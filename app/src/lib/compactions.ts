import type { Message } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

/**
 * Where a chat's context was compacted, for its thread to draw a divider on. Kept free of runtime
 * imports so `scripts/test-compactions.mjs` runs it under plain node, like `model-changes.ts`.
 */

export interface CompactionMarks {
  /** The messages to draw a divider above, each with the compaction it marks. */
  before: Map<string, Compaction>
  /** The divider a flow holding no message keeps: nothing above it, nothing after it. */
  trailing?: Compaction
}

/** When a divider is drawn: the host's own time for the compaction. */
export const compactionAt = (compaction: Compaction) => compaction.at

/**
 * Each compaction sits above the first message written after it, on the host's clock. That is exact
 * for one made between turns, and for one made as a turn opens it lands between the user's message
 * and the reply; one made while a reply runs is drawn at that reply's seam, where the fold names
 * its row. One that predates every message this device holds stands above the first of them: Hermes
 * keeps the rows it took away off the transcript, so the top of what a device can load is where its
 * compaction happened. Several in one gap are one divider, the first's. One a reply already draws
 * inside itself, at its seam, draws nothing here — the placement is this one function's to make,
 * wherever the divider ends up.
 *
 * A divider is only drawn where the thread can say what it separates. Nothing in a thread with
 * messages is "after everything": a reply is one row stamped when its turn opened, so a mark newer
 * than the last message may belong inside that reply — the work it did after the compaction is in
 * the same row — and drawing it at the foot would put it past work it came before. Such a mark
 * waits for the message written after it, the row it is drawn above. Only a chat holding no message
 * at all keeps the one that made it: a Main whose turns were all triaged away has nothing above the
 * divider, and it is still where the host compacted the context the markers below are missing.
 *
 * `undefined` is a chat nobody has read yet, which is not an empty one: it marks nothing, since the
 * rows about to arrive may hold the reply the mark fell inside.
 */
export function compactionMarks(
  messages: Message[] | undefined,
  compactions?: Compaction[],
): CompactionMarks {
  if (!compactions?.length || !messages) return { before: new Map() }
  if (!messages.length) return { before: new Map(), trailing: compactions[0] }
  const marks: CompactionMarks = { before: new Map() }
  const inside = new Set(
    messages.flatMap((message) =>
      (message.seams ?? []).map((seam) => compactionOf(seam, compactions)),
    ),
  )
  const hostTime = (message: Message) => message.hermesAt ?? message.createdAt
  for (const compaction of compactions) {
    if (inside.has(compaction)) continue
    const next = messages.find((message) => hostTime(message) > compactionAt(compaction))
    if (next && !marks.before.has(next.id)) marks.before.set(next.id, compaction)
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
