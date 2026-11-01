/** How close two Escapes must be to count as a double. */
export const DOUBLE_ESCAPE_MS = 500

/** The bots Alt+1 to Alt+9 reach. */
export const BOT_SHORTCUTS = 9

interface Press {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/**
 * Ctrl+C stops a running reply, but only when there is nothing selected to copy: the key stays
 * Copy for a selection, and for a reply that isn't running.
 */
export function isInterrupt(press: Press, busy: boolean, selecting: boolean) {
  if (!busy || selecting) return false
  if (!press.ctrlKey || press.altKey || press.shiftKey || press.metaKey) return false
  return press.key.toLowerCase() === "c"
}

/** Whether an Escape at `now` is the second of a pair, `last` being the one that came before. */
export function isDoubleEscape(last: number | null, now: number) {
  return last !== null && now - last <= DOUBLE_ESCAPE_MS
}

/**
 * The bot (zero-based) an Alt+digit reaches. It reads the physical key, since Option+digit types a
 * character on a Mac, and takes no other modifier.
 */
export function botShortcut(press: Press): number | null {
  if (!press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return null
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(press.code)
  return match ? Number(match[1]) - 1 : null
}

/**
 * Whether a press carries the send chord: Ctrl on a PC, Cmd on a Mac. Every product that keeps Enter
 * for a line break binds this pair, and a slash menu open under the field must never swallow it, so
 * the one definition serves both the rule below and the composer's pick branch (ADR 0078).
 */
export function isSendChord(press: Press) {
  return press.ctrlKey || press.metaKey
}

/**
 * Whether one Enter in the composer sends the message. The switch is this device's own
 * (`sendOnEnter`, Settings > Appearance, off by default), so out of the box Enter is a line break —
 * what a multiline field does everywhere — and the chord sends. Shift never sends, so a line is
 * always one key away.
 */
export function enterSends(press: Press, sendOnEnter: boolean) {
  if (press.shiftKey) return false
  return isSendChord(press) || sendOnEnter
}
