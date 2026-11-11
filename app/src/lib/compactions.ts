import type { Message, Seam, ToolEvent } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

/**
 * Where a chat's context was compacted, for its thread to draw a divider on. Kept free of runtime
 * imports so `scripts/test-compactions.mjs` runs it under plain node, like `model-changes.ts`.
 */

export interface CompactionMarks {
  /** The messages to draw a divider above, each with the compaction it marks. */
  before: Map<string, Compaction>
  /**
   * The seams a reply draws no divider at: one stands in the same gap instead, or nothing the reader
   * sees is drawn on one side of it.
   */
  replaced: Set<string>
}

/** When a divider is drawn: the host's own time for the compaction. */
export const compactionAt = (compaction: Compaction) => compaction.at

/** A divider the thread would draw: one the host's record places between turns, or a reply's seam. */
interface Divider {
  compaction?: Compaction
  /** The message the host's record stands above, for one placed between two messages. */
  above?: string
  /** The seam the reply draws it at, for one that fell inside a reply. */
  seam?: Seam
}

/** A stretch of a message the reader sees: the user's words, or a reply's words and calls. */
const WORDS = { kind: "words" } as const
type Slot = { kind: "divider"; divider: Divider } | typeof WORDS

/**
 * Each compaction sits above the first message written after it, on the host's clock. That is exact
 * for one made between turns, and for one made as a turn opens it lands between the user's message and
 * the reply; one made while a reply runs lands inside that reply, at its seam, where the transcript
 * holds the summary's row. Several in one gap are one divider.
 *
 * Two rules then decide whether a divider is drawn at all, and both are about what the reader sees
 * rather than what the host recorded:
 *
 * - It stands between two drawn messages: a user's words, or a reply's words or calls. A divider with
 *   nothing drawn above it — the top of a chat whose archive isn't loaded, a chat this device holds
 *   nothing of — is this device guessing at a row it hasn't read, and the archive puts the divider
 *   back where it happened once the reader loads it. One with nothing drawn below it — a compaction
 *   after everything written, a reply still being typed — marks a boundary whose other side doesn't
 *   exist yet, and it would move down the thread as the run goes on.
 * - Between two drawn messages there is at most one divider. A reply's seam and the host's record can
 *   each place one in the same gap; the one whose label names a size survives, else the earlier.
 *
 * Where a divider falls is still this one function's to say, wherever the thread ends up drawing it.
 */
export function compactionMarks(messages: Message[], compactions?: Compaction[]): CompactionMarks {
  const marks: CompactionMarks = { before: new Map(), replaced: new Set() }
  if (!compactions?.length || !messages.length) return marks
  const inside = new Set(
    messages.flatMap((message) =>
      (message.seams ?? []).map((seam) => compactionOf(seam, compactions)),
    ),
  )
  // The host's own time where the row kept it: `createdAt` is this device's, and a catch-up can
  // floor it forward past the mark, one row the wrong side of the line.
  const at = (message: Message) => message.hermesAt ?? message.createdAt
  // One divider per gap where the record places several: the one whose label names a size, else the
  // earliest the host recorded.
  const gaps = new Map<number, Compaction>()
  for (const compaction of compactions) {
    if (inside.has(compaction)) continue
    const next = messages.findIndex((message) => at(message) > compactionAt(compaction))
    if (next < 0) continue
    const held = gaps.get(next)
    if (!held || (!held.tokens && compaction.tokens)) gaps.set(next, compaction)
  }
  const slots: Slot[] = []
  messages.forEach((message, index) => {
    const gap = gaps.get(index)
    if (gap) slots.push({ kind: "divider", divider: { compaction: gap, above: message.id } })
    for (const slot of drawnOf(message, compactions)) slots.push(slot)
  })
  for (const { kept, gone, start, end } of oneEach(slots)) {
    for (const divider of gone) if (divider.seam) marks.replaced.add(divider.seam.id)
    const drawn = words(slots, start - 1, -1, 0) && words(slots, end + 1, 1, slots.length)
    if (!drawn && kept.seam) marks.replaced.add(kept.seam.id)
    if (drawn && kept.above) marks.before.set(kept.above, kept.compaction!)
  }
  return marks
}

/**
 * One divider per gap: each run of dividers with nothing drawn between them, answered by the one
 * whose label names a size, else the earlier — with the dividers it replaced, and the slots its run
 * began and ended at, so what sits either side of it is read from there.
 */
function oneEach(slots: Slot[]) {
  const answered: { kept: Divider; gone: Divider[]; start: number; end: number }[] = []
  for (let start = 0; start < slots.length; start++) {
    const slot = slots[start]
    if (slot.kind !== "divider") continue
    const run: Divider[] = [slot.divider]
    let end = start
    while (end + 1 < slots.length && slots[end + 1].kind === "divider") {
      run.push((slots[++end] as { kind: "divider"; divider: Divider }).divider)
    }
    const index = run.findIndex((one) => one.compaction?.tokens)
    const kept = index < 0 ? run[0] : run[index]
    answered.push({ kept, gone: run.filter((one) => one !== kept), start, end })
    start = end
  }
  return answered
}

/** Whether anything the reader sees is drawn from `from` to `to`, stepping `step`. */
const words = (slots: Slot[], from: number, step: 1 | -1, to: number) => {
  for (let at = from; step > 0 ? at < to : at >= to; at += step)
    if (slots[at].kind === "words") return true
  return false
}

/**
 * What a message draws, with the dividers of its own seams in it: its words and calls, split where a
 * compaction fell, in the order the reply's drawing puts them. A steer the user sent while the reply
 * ran is drawn in there too, and it is the user's words — a side of a divider like any other.
 */
function drawnOf(message: Message, compactions: Compaction[]): Slot[] {
  const breaks = [
    ...(message.seams ?? []).map((seam) => ({
      toolsBefore: seam.toolsBefore,
      contentOffset: seam.contentOffset,
      divider: { seam, compaction: compactionOf(seam, compactions) } as Divider | undefined,
    })),
    ...(message.steers ?? []).map((steer) => ({
      toolsBefore: steer.toolsBefore ?? 0,
      contentOffset: steer.contentOffset,
      divider: undefined,
    })),
  ].sort((a, b) => a.toolsBefore - b.toolsBefore || a.contentOffset - b.contentOffset)
  const content = message.content ?? ""
  const calls = message.tools ?? []
  const slots: Slot[] = []
  let offset = 0
  let callsBefore = 0
  let opening = true
  for (const one of breaks) {
    const end = Math.min(Math.max(one.contentOffset, offset), content.length)
    const before = Math.min(Math.max(one.toolsBefore, callsBefore), calls.length)
    if (drawn(message, content.slice(offset, end), calls.slice(callsBefore, before), opening))
      slots.push(WORDS)
    slots.push(one.divider ? { kind: "divider", divider: one.divider } : WORDS)
    offset = end
    callsBefore = before
    opening = false
  }
  if (drawn(message, content.slice(offset), calls.slice(callsBefore), opening)) slots.push(WORDS)
  return slots
}

/**
 * Whether a stretch of a message draws anything: words, a call, the files the user sent, or the
 * thinking that opens the message. Anything but the words opens it alone — a reply that has made a
 * call and said nothing yet is still something the reader is looking at.
 */
function drawn(message: Message, text: string, calls: ToolEvent[], opening: boolean) {
  return (
    text.trim().length > 0 ||
    calls.length > 0 ||
    (opening && Boolean(message.attachments?.length)) ||
    (opening && Boolean(message.reasoningRuns?.length || message.reasoning))
  )
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
