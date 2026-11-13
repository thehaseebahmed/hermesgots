/**
 * The mark a pinned canvas's row draws (issue #1065), as the record keeps it: one lucide icon's name
 * or one emoji, and — for an icon — the name of the palette colour it takes.
 *
 * Import-free, so `scripts/test-canvas-mark.mjs` runs it as a pure rule: what a stored string means,
 * how an icon's name reads as words, and which marks a search keeps.
 */

/** The colours an icon's mark takes, as the record names them (`canvases.py`'s `MARK_TINTS`). */
export const MARK_TINTS = ["blue", "cyan", "green", "yellow", "coral", "pink", "purple"] as const
export type MarkTint = (typeof MARK_TINTS)[number]

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
  if (/[A-Za-z0-9\s]/.test(raw)) return undefined
  return { kind: "emoji", glyph: raw }
}

/** The palette colour a stored tint names; a name this build doesn't know is no colour at all. */
export function readTint(raw: string | undefined): MarkTint | undefined {
  return MARK_TINTS.find((tint) => tint === raw)
}

/** `alarm-clock-minus` as `Alarm clock minus`: what a search reads and a row's own label says. */
export function markWords(name: string): string {
  const words = name.replaceAll("-", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Whether a mark's words survive a search's words: an empty field narrows nothing. */
export function markMatches(words: string, query: string): boolean {
  return words.toLowerCase().includes(query.trim().toLowerCase())
}

/**
 * The ink an icon's mark draws in, per palette name: the colour, and a lighter one for a dark theme
 * so a tint reads as the same colour on either.
 */
export const TINT_INK: Record<MarkTint, string> = {
  blue: "text-blue-500 dark:text-blue-400",
  cyan: "text-cyan-500 dark:text-cyan-300",
  green: "text-emerald-600 dark:text-emerald-400",
  yellow: "text-amber-500 dark:text-amber-300",
  coral: "text-orange-500 dark:text-orange-400",
  pink: "text-pink-500 dark:text-pink-400",
  purple: "text-purple-500 dark:text-purple-400",
}

/** The same colours as the picker's swatches, which fill rather than ink. */
export const TINT_FILL: Record<MarkTint, string> = {
  blue: "bg-blue-500",
  cyan: "bg-cyan-500",
  green: "bg-emerald-600",
  yellow: "bg-amber-500",
  coral: "bg-orange-500",
  pink: "bg-pink-500",
  purple: "bg-purple-500",
}
