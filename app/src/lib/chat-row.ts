/**
 * A row of the chat list: the bot whose record it is, the bot this device holds for it, and whether
 * that bot can answer for it today.
 *
 * A record's `profileId` names the bot whose list carried it. For a chat that is also the bot whose
 * screen the row opens on; for a room it is bookkeeping, since a room belongs to a Host and answers
 * through a member resolved from its roster (ADR 0115). So what a row is, and what answers for it, is
 * asked here rather than read off the field at each screen that draws a row.
 */

/** A chat row, as these rules read it. */
type Row = { profileId: string }

/**
 * The bot whose record carried a row: whose row it is, and — until a room separates the two — whose
 * screen it opens on.
 */
export function rowOwner(row: Row): string {
  return row.profileId
}

/** The bot this device holds for a row, when it holds one. */
export function rowBot<B>(row: Row, bots: ReadonlyMap<string, B>): B | undefined {
  return bots.get(rowOwner(row))
}

/**
 * Whether a row's bot can answer for it today: one the user has turned off answers nothing, and the
 * row is not drawn. A bot this device doesn't hold is not one that is off — deleting a bot takes its
 * chats with it — so nothing here hides a row for a record that outlived its bot.
 */
export function rowAnswers(row: Row, bots: ReadonlyMap<string, { disabled?: boolean }>): boolean {
  return bots.get(rowOwner(row))?.disabled !== true
}
