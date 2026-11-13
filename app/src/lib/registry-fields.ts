/**
 * What a registry read owns on a bot, and nothing else: the fields the account's bot record is the
 * only source for. Kept out of `registry.ts` so the rule can be run on its own, without a database
 * or a network — the tier this belongs to, since what it decides is one derivation.
 */

/**
 * A record as the registry holds it: whether the bot is on. Nothing about when its host was last
 * heard — presence is the chat-list pass's own answer, and the timestamp that goes with it is this
 * device's, written by the pass and never read back from the account.
 */
export interface CheckIn {
  enabled: boolean
}

/** What the plugin seals for the app (`record` in `plugin/link.py`), as far as this read reads it. */
export interface SealedBot {
  /** The Hermes profile the bot is; absent from a record sealed before the plugin sent one. */
  profile?: string
  pluginVersion?: string
}

/**
 * The local fields one registry read writes. A field the record doesn't carry is left out rather
 * than written as `undefined`: Dexie's `update` deletes a key set to undefined, which would take
 * away a name an earlier read learned.
 *
 * The version is the sealed record's own, and only it: a check-in carries a version too, but a
 * record the account holds may be older than the plugin that just checked in, so the host's own
 * live read (`usePluginVersion`) is what keeps this field current.
 */
export function localFields(record: CheckIn, value: SealedBot) {
  return {
    disabled: !record.enabled || undefined,
    pluginVersion: value.pluginVersion,
    ...(value.profile ? { hermesProfile: value.profile } : {}),
  }
}
