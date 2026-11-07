/**
 * The split a reader drags between Main and its bot's thread (ADR 0110): the share of the lane Main
 * keeps, a fraction of the row rather than a width — the sidebar may be open or a rail, and half is
 * right in both — kept on this device for every bot rather than one per bot, and floored at 412px a
 * side, the width the app already asks its text to read in. The floor is written as a CSS `clamp`,
 * so no resize listener is needed and no window can crush either chat.
 */

/** The narrowest either chat is drawn: the lane Main alone kept before the split. */
export const SPLIT_FLOOR = 412

/** Where the split opens, and where Enter, Home and a double-click put it back: half the row. */
export const SPLIT_HALF = 0.5

/** What an arrow key moves the edge by, and what Shift moves it by: four times as far. */
export const SPLIT_STEP = 0.04
export const SPLIT_STEP_FAST = SPLIT_STEP * 4

/** Where the share is kept — one for the device, so a bot switch, a close and a launch all find it. */
export const SPLIT_KEY = "gots:split-share"

/**
 * A share as the width the list's lane takes: a percentage of the row, held between 412px and the
 * row less 412px. Both halves read it, so the floor can never favour one chat over the other.
 */
export function splitWidth(share: number): string {
  return `clamp(${SPLIT_FLOOR}px, ${Math.round(share * 10_000) / 100}%, calc(100% - ${SPLIT_FLOOR}px))`
}

/** Where a pointer puts the edge, as the share of the row it is over. */
export function shareAt(x: number, row: { left: number; width: number }): number {
  if (!row.width) return SPLIT_HALF
  return shareKept((x - row.left) / row.width)
}

/** A share kept to the row it is a share of, so a drag past either end stops at the end. */
export function shareKept(share: number): number {
  return Math.min(1, Math.max(0, Math.round(share * 10_000) / 10_000))
}

/** The share this device last moved to, or half where nothing was kept or it can't be read. */
export function readSplit(): number {
  try {
    const kept = localStorage.getItem(SPLIT_KEY)
    const share = kept === null ? NaN : Number(kept)
    return Number.isFinite(share) && share >= 0 && share <= 1 ? share : SPLIT_HALF
  } catch {
    return SPLIT_HALF
  }
}

/** Keeps a share for this device, where storage will take it. */
export function writeSplit(share: number) {
  try {
    localStorage.setItem(SPLIT_KEY, String(shareKept(share)))
  } catch {
    // Storage blocked: the page's own share still holds for as long as the page lives.
  }
}
