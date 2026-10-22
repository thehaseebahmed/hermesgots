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
