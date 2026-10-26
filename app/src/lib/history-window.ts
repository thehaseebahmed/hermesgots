import type { Conversation } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

/**
 * The window a chat's thread holds, as it grows backwards: which row numbering a step walks — the
 * live transcript, or the host's display read that also carries the rows a compaction archived —
 * where the step landed, and what the cursor becomes. Kept free of runtime imports so
 * `scripts/test-history-window.mjs` runs it under plain node, like `compactions.ts`.
 *
 * The two reads count differently: the live transcript's offset counts its own rows, the display
 * read's counts one per logical message, archived ones included. So a step is only ever walked in
 * the numbering it started in, and the handover between them is this rule's whole job.
 *
 * A step keeps every row the device doesn't hold yet, in the order the host gave them: the display
 * read orders by the host's own display position, which parts ways with the row ids once a
 * compaction re-emits carried turns under fresh ones, so nothing here compares ids to decide what
 * sits above the window. Running out of a numbering is the only thing that ends it.
 */

/** Hermes holds rows older than this device's: the oldest row's id, and how far from the newest end
 *  it sits in the numbering being walked (`archived` says which). */
export type WindowCursor = NonNullable<Conversation["olderThan"]>

/** What one step of the window found. */
export interface WindowStep {
  /** The oldest row the step kept, or undefined when it kept none. */
  oldest?: number
  /** The page came back short: nothing further in this numbering. */
  end: boolean
  /** Rows read from the newest end once the step's pages were done, in this numbering. */
  offset: number
}

export interface WindowNext {
  /** What the chat stores, or undefined when the window has reached the chat's first row. */
  cursor?: WindowCursor
  /** Whether another step can be taken now. */
  more: boolean
}

/**
 * Whether the host said the chat holds archived rows. Only its own list says so: an empty list is a
 * chat that was never compacted, and a list nobody has read is a question still open — neither is a
 * reason to read a display order, which answers every row the device already holds.
 */
export function mayHoldArchive(compactions?: Compaction[]): boolean {
  return (compactions?.length ?? 0) > 0
}

/**
 * Where the window goes after one step. A step that kept rows keeps walking the numbering it was
 * walking, until that numbering runs out — and running out of the live transcript is not the end of
 * the chat but the start of the archive. The display read then starts again from the newest end,
 * since its numbering is its own and the row id is what says where the window's edge is.
 */
export function nextWindow(
  cursor: WindowCursor,
  step: WindowStep,
  archive: boolean,
): WindowNext {
  const archived = Boolean(cursor.archived)
  if (step.oldest === undefined) {
    if (archived || !archive) return { more: false }
    return { cursor: { id: cursor.id, offset: 0, archived: true }, more: true }
  }
  if (!step.end)
    return {
      cursor: {
        id: step.oldest,
        offset: step.offset,
        ...(archived ? { archived: true } : {}),
      },
      more: true,
    }
  if (!archived && archive)
    return { cursor: { id: step.oldest, offset: 0, archived: true }, more: true }
  return { more: false }
}
