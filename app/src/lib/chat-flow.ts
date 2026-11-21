import type { Message } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

import { compactionAt, type CompactionMarks } from "./compactions.ts"

/**
 * The flow one chat draws, whichever screen draws it: its messages in the thread's own order, with a
 * compaction's divider above the message it sits over and any mark a screen names above the message
 * that followed it. What a screen adds around those entries — Main's cards and moved markers, the day
 * heading over the first thing each day holds — is that screen's decoration, which is why this rule
 * answers entries rather than rows (ADR 0097).
 */

/** A compaction's divider, as a flow draws it: the host's own time for it, and the compaction it marks. */
export interface CompactionEntry {
  kind: "compaction"
  at: number
  compaction: Compaction
}

/**
 * Something a screen marks in a chat's flow — a build's visit, in the canvas lane — placed above the
 * first message that came at or after it. It carries no node: this rule answers data, and the view
 * that draws it decides what a mark looks like.
 */
export interface ChatMark {
  /** When it happened, in ms, on the clock a message's `createdAt` keeps. */
  at: number
  words: string
  /** What a check found, where the mark names one. */
  flag?: string
}

export interface MarkEntry extends ChatMark {
  kind: "mark"
}

/** An entry one chat's flow draws: a message, the divider of a compaction above one, or a mark a screen named. */
export type ChatFlowEntry = { kind: "message"; message: Message } | CompactionEntry | MarkEntry

export const compactionEntry = (compaction: Compaction): CompactionEntry => ({
  kind: "compaction",
  at: compactionAt(compaction),
  compaction,
})

/**
 * The entries a chat draws: each message, with the divider of whatever compaction the host placed
 * above it (`compactionMarks`) and any mark the screen named that came before it, in the one order
 * the thread holds. A compaction the record keeps off the thread — one inside a reply, or with nothing
 * drawn on a side of it — draws nothing here, and its placement is `compactionMarks`' answer, not this
 * fold's.
 *
 * A mark is placed by time, not by id, because what a screen marks happened while the chat was being
 * written — `marks` are given in the order they happened and drawn in that order: a mark stamped at or
 * before a message's clock stands above that message, and one that began after the last message read
 * so far stands at the foot of what is drawn. A message the thread does not date (`createdAt` 0, a
 * send this device is still holding) is later than every mark, since a held message is the newest
 * thing the flow has.
 */
export function chatFlow({
  thread,
  compacted,
  marks,
}: {
  thread?: readonly Message[]
  compacted?: CompactionMarks
  marks?: readonly ChatMark[]
}): ChatFlowEntry[] {
  const entries: ChatFlowEntry[] = []
  const given = marks ?? []
  let next = 0
  for (const message of thread ?? []) {
    const compaction = compacted?.before.get(message.id)
    if (compaction) entries.push(compactionEntry(compaction))
    const at = message.createdAt
    while (next < given.length && (at === 0 || given[next].at <= at)) {
      entries.push({ kind: "mark", ...given[next++] })
    }
    entries.push({ kind: "message", message })
  }
  for (const mark of given.slice(next)) entries.push({ kind: "mark", ...mark })
  return entries
}
