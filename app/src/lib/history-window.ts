import type { Conversation } from "@/lib/db"
import type { Compaction } from "@/lib/hermes"

/** Where the window's edge sits, and in which numbering. Kept free of runtime imports so
 *  `scripts/test-history-window.mjs` runs it under plain node, like `compactions.ts`. */
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

/**
 * Whether the host said the chat holds archived rows. Only its own list says so: an empty list is a
 * chat that was never compacted, and a list nobody has read is a question still open — neither is a
 * reason to read a display order, which answers every row the device already holds.
 */
export function mayHoldArchive(compactions?: Compaction[]): boolean {
  return (compactions?.length ?? 0) > 0
}

/** The cursor as one value the screen watches for movement. */
export function windowKey(cursor: WindowCursor): string {
  return cursor.kind === "archive" ? `${cursor.id}:archive` : `${cursor.id}:${cursor.offset}`
}

/**
 * Where the window goes after one step, or undefined once it has reached the chat's first row. A
 * step keeps walking the numbering it was walking; running out of the live transcript is not the
 * end of the chat but the start of the archive, which begins at its own newest end.
 */
export function nextWindow(
  cursor: WindowCursor,
  step: WindowStep,
  archive: boolean,
): WindowCursor | undefined {
  const live = (id: number, offset: number): WindowCursor => ({ kind: "live", id, offset })
  // An absent kind is the live transcript's: it is what every released build wrote, and the archive
  // is the one numbering that has to be named to be walked.
  const inArchive = cursor.kind === "archive"
  if (step.oldest === undefined) {
    // Every row it read is one the device holds. A numbering with more to give moves on without
    // claiming an edge it never reached.
    if (!step.end) return inArchive ? cursor : live(cursor.id, step.offset)
    if (inArchive || !archive) return undefined
    return { kind: "archive", id: cursor.id }
  }
  if (!step.end)
    return inArchive ? { kind: "archive", id: step.oldest } : live(step.oldest, step.offset)
  if (!inArchive && archive) return { kind: "archive", id: step.oldest }
  return undefined
}
