/**
 * A row of the chat list: the bot it belongs to, and the bot that answers for it today.
 *
 * A record's `profileId` names the bot whose list carried it. That is the bot a chat belongs to, and
 * only bookkeeping for a room, which rides whichever member's list carried it and whose Host and
 * answering member are resolved from its roster (ADR 0115). So the two questions are asked here,
 * once, rather than read off the field at each screen that draws a row.
 */

/** A chat row, as these rules read it. */
type Row = { profileId: string }

/** The bot a row belongs to: whose row it is, and whose screen it opens on. */
export function rowOwner(row: Row): string {
  return row.profileId
}

/**
 * The bot that answers for a row today: the one its owner names, when this device holds that bot and
 * the user has left it on. `undefined` is a row no bot answers for, which the list draws nothing for.
 */
export function rowBot<B extends { disabled?: boolean }>(
  row: Row,
  bots: ReadonlyMap<string, B>,
): B | undefined {
  const bot = bots.get(rowOwner(row))
  return bot && !bot.disabled ? bot : undefined
}
