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
