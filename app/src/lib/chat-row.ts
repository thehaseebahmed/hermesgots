/**
 * A row of the chat list: the bot whose record it is, the bot this device holds for it, and whether
 * the list draws it.
 *
 * A record's `profileId` names the bot whose list carried it. For a chat that is also the bot whose
 * screen the row opens on; for a room it is bookkeeping, since a room belongs to a Host and answers
 * through a member resolved from its roster (ADR 0115). So what a row is, and what answers for it, is
 * asked here rather than read off the field at each screen that draws a row.
 */

export type ChatRow = { profileId: string }

/** The `profileId` a row carries: for a room, only the bot whose list carried its record. */
export function rowProfileId(row: ChatRow): string {
  return row.profileId
}

export function rowBot<B extends { disabled?: boolean }>(
  row: ChatRow,
  bots: ReadonlyMap<string, B>,
): B | undefined {
  return bots.get(rowProfileId(row))
}

/**
 * Whether the chat list draws a row: one whose bot the user has turned off draws nothing. A bot this
 * device doesn't hold is not one that is off — deleting a bot takes its chats with it — so nothing
 * here hides a row for a record that outlived its bot.
 */
export function rowDraws(row: ChatRow, bots: ReadonlyMap<string, { disabled?: boolean }>): boolean {
  return rowBot(row, bots)?.disabled !== true
}
