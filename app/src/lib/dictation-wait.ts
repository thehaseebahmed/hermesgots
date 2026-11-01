/**
 * A take's wait: **Stop to text**, the device's number (ADR 0075). It runs from the Stop the user
 * pressed to the words standing in the composer, in four parts — the recorders closing, the last
 * Upload, the Confirm's round trip and the insert — and it is the app's own share and nothing more.
 * A mock host answers in a constant time and no decoder runs behind it, so this number can never be
 * read as the host's Confirm span.
 *
 * Nothing draws it and nothing measures itself against it: `scripts/regression-dictation.mjs` prints
 * it from the flow that already dictates, reported rather than asserted, and the bench in
 * `bench/dictation/` is what holds a bar on a host that hears a take.
 */

/** The parts of a take's wait, each from the mark before it to its own, in the order they happen. */
export const WAIT_PARTS = ["closed", "uploaded", "answered", "inserted"] as const

export type WaitPart = (typeof WAIT_PARTS)[number]

export interface TakeWait {
  /** The Take id the wait belongs to, so an ending a newer take replaced writes nothing into it. */
  take: string
  /** When the user pressed Stop. */
  stop: number
  /** The recorders closed and the take's last Piece was cut. */
  closed?: number
  /** The host had taken every Piece the take holds. */
  uploaded?: number
  /** The one Confirm answered. */
  answered?: number
  /** The words took the composer. */
  inserted?: number
}

export interface WaitSpan {
  part: WaitPart
  ms: number
}

let last: TakeWait | null = null

/** Opens a take's wait at the Stop the user pressed, forgetting the take before it. */
export function waitStarts(take: string, at = Date.now()) {
  last = { take, stop: at }
}

/** One part of the wait reached, on the take still under way; a part is recorded once. */
export function waitReaches(take: string, part: Exclude<WaitPart, "inserted">, at = Date.now()) {
  if (!last || last.take !== take || last[part] !== undefined) return
  last[part] = at
}

/**
 * The take the last Stop opened ended without reaching the composer — cancelled, or sent again under
 * a fresh Take id — so no words are owed it: nothing closes its wait, and the next Stop opens a new one.
 */
export function waitDrops() {
  last = null
}

/**
 * The words took the composer. The composer is not told which take its words came from, so this
 * closes the wait the last Stop opened — a take dropped since then, or one Retry re-sent, has no wait
 * left to close.
 */
export function waitInserted(at = Date.now()) {
  if (!last || last.inserted !== undefined) return
  last.inserted = at
}

/** The last take's wait, as it stands: a copy, so a reader cannot write into it. */
export function lastWait(): TakeWait | null {
  return last && { ...last }
}

/** The parts the take reached, each spanned by its own mark and the one before it. */
export function waitSpans(wait: TakeWait): WaitSpan[] {
  const spans: WaitSpan[] = []
  let from = wait.stop
  for (const part of WAIT_PARTS) {
    const at = wait[part]
    // A take that died before a part leaves the rest unspanned: no mark, no span, and no guess.
    if (at === undefined) break
    spans.push({ part, ms: Math.max(0, at - from) })
    from = at
  }
  return spans
}

/** The whole wait, from the Stop to the words: null until the take reached the composer. */
export function waitTotal(wait: TakeWait): number | null {
  return wait.inserted === undefined ? null : Math.max(0, wait.inserted - wait.stop)
}
