/**
 * A routine's message: the bot said it while working, rather than in a turn of this chat.
 *
 * A plugin older than the delivery that publishes a row of its own wrote an answer into a chat as an
 * assistant row carrying `display_kind` (ADR 0081). Those rows are still in hosts' transcripts and in
 * chats this device synced, so the mark stays and both folds read it from here — the current chat's
 * (`history.ts`) and the new thread's (`chat-next/fold.ts`) — and a routine's answer draws as a
 * message of the bot's own on either screen rather than folding into the reply above it.
 *
 * A delivery made since is a row of its own (`Conversation.routine`), read by its run's own screen:
 * nothing draws a chip from here, and nothing here asks a host for anything.
 *
 * Import-free on purpose: the unit tier loads this file under `node --experimental-strip-types`.
 */
export const ROUTINE_KIND = "routine_message"

/** Whether this transcript row is a routine's own message rather than part of a reply. */
export const isRoutineRow = (row: { display_kind?: string | null }) =>
  row.display_kind === ROUTINE_KIND
