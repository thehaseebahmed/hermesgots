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
