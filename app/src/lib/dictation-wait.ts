/**
 * A take's wait: **Stop to text**, the device's number (ADR 0075) — the app's own share, never the
 * host's, since a mock answers in a constant time and no decoder sits behind it. A mark is an offset
 * on the monotonic clock, never a date; the insert is the composer taking the words, which is its own
 * state write, so the field paints them a frame later. Nothing draws the record:
 * `scripts/regression-dictation.mjs` prints it, reported rather than asserted, and the bench in
 * `bench/dictation/` holds the bar.
 */

/** The parts of a take's wait, each from the mark before it to its own, in the order they happen. */
export const WAIT_PARTS = ["closed", "uploaded", "answered", "inserted"] as const

export type WaitPart = (typeof WAIT_PARTS)[number]

/** The Take id the app minted when a recording started, which a wait is owned by. */
export type TakeId = string

/** The words each part is printed as, so a part added here cannot print unnamed in a flow. */
export const WAIT_PART_LABELS: Record<WaitPart, string> = {
  closed: "recorders closing",
  uploaded: "last Upload",
  answered: "Confirm's round trip",
  inserted: "insert",
}

export interface TakeWait {
  /** The Take id the wait belongs to: an ending another take owns writes nothing into it. */
  take: TakeId
  stop: number
  closed?: number
  uploaded?: number
  answered?: number
  inserted?: number
}

export interface WaitSpan {
  part: WaitPart
  ms: number
}

let last: TakeWait | null = null

/** Leaves a part's mark: once, and only on the wait the take it names still owns. */
function mark(takeId: TakeId, part: WaitPart, at: number) {
  if (!last || last.take !== takeId || last[part] !== undefined) return
  last[part] = at
}

/** Opens a take's wait at the Stop the user pressed. */
export function waitStarts(takeId: TakeId, at = performance.now()) {
  last = { take: takeId, stop: at }
}

/** One part of the wait reached — the recorders closed, the last Upload taken, the Confirm answered. */
export function waitReaches(
  takeId: TakeId,
  part: Exclude<WaitPart, "inserted">,
  at = performance.now(),
) {
  mark(takeId, part, at)
}

/** The words took the composer. */
export function waitInserted(takeId: TakeId, at = performance.now()) {
  mark(takeId, "inserted", at)
}

/** Ends the wait of a take whose words will never stand in the composer. */
export function waitDrops(takeId: TakeId) {
  if (last?.take === takeId) last = null
}

/** The last Stop's wait, as it stands: a copy, and null once that take ended without words. */
export function lastWait(): TakeWait | null {
  return last && { ...last }
}

/** The parts the take reached, each spanned by its own mark and the one before it. */
export function waitSpans(wait: TakeWait): WaitSpan[] {
  const spans: WaitSpan[] = []
  let from = wait.stop
  for (const part of WAIT_PARTS) {
    const at = wait[part]
    // A take still under way has no mark past its last part: no span, and no guess.
    if (at === undefined) break
    spans.push({ part, ms: at - from })
    from = at
  }
  return spans
}

/** The whole wait, from the Stop to the words: null until every part has a mark. */
export function waitTotal(wait: TakeWait): number | null {
  if (WAIT_PARTS.some((part) => wait[part] === undefined)) return null
  const words = wait.inserted
  return words === undefined ? null : words - wait.stop
}
