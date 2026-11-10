import type { Message } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

import { compactionAt, type CompactionMarks } from "./compactions.ts"

/**
 * The flow one chat draws, whichever screen draws it: its messages in the thread's own order, with a
 * compaction's divider above the message it sits over. What a screen adds around those entries — Main's
 * cards and moved markers, the day heading over the first thing each day holds — is that screen's
 * decoration, which is why this rule answers entries rather than rows (ADR 0097).
 */

/** A compaction's divider, as a flow draws it: the host's own time for it, and the compaction it marks. */
export interface CompactionEntry {
  kind: "compaction"
  at: number
  compaction: Compaction
}

/** An entry one chat's flow draws: a message, or the divider of a compaction above one. */
export type ChatFlowEntry = { kind: "message"; message: Message } | CompactionEntry

export const compactionEntry = (compaction: Compaction): CompactionEntry => ({
  kind: "compaction",
  at: compactionAt(compaction),
  compaction,
})

/**
 * The entries a chat draws: each message, with the divider of whatever compaction the host placed
 * above it (`compactionMarks`), in the one order the thread holds. A compaction the record keeps off
 * the thread — one inside a reply, or with nothing drawn on a side of it — draws nothing here, and its
 * placement is `compactionMarks`' answer, not this fold's.
 */
export function chatFlow({
  thread,
  compacted,
}: {
  thread?: readonly Message[]
  compacted?: CompactionMarks
}): ChatFlowEntry[] {
  const entries: ChatFlowEntry[] = []
  for (const message of thread ?? []) {
    const compaction = compacted?.before.get(message.id)
    if (compaction) entries.push(compactionEntry(compaction))
    entries.push({ kind: "message", message })
  }
  return entries
}
