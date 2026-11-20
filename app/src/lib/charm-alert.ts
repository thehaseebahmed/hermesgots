/**
 * The rules the charm's alerts obey, kept import-free so a desktop test can run them.
 */

/**
 * The id a charm's bot entry carries: the registry's when the registry holds this bot, since that
 * is the id a push names and the id an alert is matched against, and the bot's own otherwise.
 */
export function charmBotId(profileId: string, registryId?: string): string {
  return registryId ? registryId : profileId
}

/**
 * Minutes since local midnight, which is how an alert says when it was raised: the reader's own
 * clock, so the charm's minute agrees with the one on the phone. The moment is handed in, never
 * read here, so a test builds the same frame every time.
 */
export function minuteOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}
