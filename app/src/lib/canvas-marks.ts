/**
 * The mark a pinned canvas's row draws (issue #1065), as the record keeps it: one lucide icon's name
 * or one emoji.
 *
 * Import-free, so `scripts/test-canvas-mark-rules.mjs` runs it as a pure rule: what a stored string
 * means, how an icon's name reads as words, and which marks a search keeps.
 */

/** A mark, read: an icon of that name, or one emoji. */
export type Mark = { kind: "icon"; name: string } | { kind: "emoji"; glyph: string }

/** An icon's name, as lucide writes one: lower case, hyphenated, and nothing else. */
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * What a stored mark draws, or nothing when the canvas has none: an empty string is a canvas whose
 * mark was cleared, which draws the app's own frame like one that never had a mark.
 *
 * A word is no mark. The host refuses one (`canvases.py`'s `_mark`), so a record holding one — an
 * older app's, a hand edit — draws the frame rather than spelling it out in the row's 20px slot.
 */
export function readMark(raw: string | undefined): Mark | undefined {
  if (!raw) return undefined
  if (ICON_NAME.test(raw)) return { kind: "icon", name: raw }
  if (/[\p{L}\p{N}\s]/u.test(raw)) return undefined
  return { kind: "emoji", glyph: raw }
}

/** `alarm-clock-minus` as `Alarm clock minus`: what a search reads and a cell's own label says. */
export function markWords(name: string): string {
  const words = name.replaceAll("-", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Whether a mark's words survive a search's words: an empty field narrows nothing. */
export function markMatches(words: string, query: string): boolean {
  return words.toLowerCase().includes(query.trim().toLowerCase())
}
