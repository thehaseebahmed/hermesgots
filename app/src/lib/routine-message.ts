/**
 * A routine's message: the bot said it while working, rather than in a turn of this chat (ADR 0081).
 *
 * The host marks the row with `display_kind`, and both folds read that one mark from here — the
 * current chat's (`history.ts`) and the new thread's (`chat-next/fold.ts`) — so a routine's answer
 * draws as a message of the bot's own on either screen.
 *
 * Import-free on purpose: the unit tier loads this file under `node --experimental-strip-types`.
 */
export const ROUTINE_KIND = "routine_message"

/** Whether this transcript row is a routine's own message rather than part of a reply. */
export const isRoutineRow = (row: { display_kind?: string | null }) =>
  row.display_kind === ROUTINE_KIND

/**
 * How long a routine ran, in the shortest words that keep it whole: "12s", "2m 14s", "1h 3m". A
 * routine is usually over inside a minute, so the seconds are the part worth showing; past an hour
 * they stop mattering.
 */
export function ranFor(seconds: number) {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return `${whole}s`
  if (whole < 3600) {
    const minutes = Math.floor(whole / 60)
    const rest = whole % 60
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  }
  const hours = Math.floor(whole / 3600)
  const minutes = Math.round((whole % 3600) / 60)
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}
