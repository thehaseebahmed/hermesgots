/**
 * What a registry read owns on a bot, and nothing else: the fields the host's own check-in is the
 * only source for. Kept out of `registry.ts` so the rule can be run on its own, without a database
 * or a network — the tier this belongs to, since what it decides is one derivation.
 */

/** A record as the registry holds it: whether the bot is on, and when its host last checked in. */
export interface CheckIn {
  enabled: boolean
  seen?: { at: number; pluginVersion?: string }
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
 */
export function localFields(record: CheckIn, value: SealedBot) {
  return {
    disabled: !record.enabled || undefined,
    seenAt: record.seen?.at,
    pluginVersion: record.seen?.pluginVersion ?? value.pluginVersion,
    ...(value.profile ? { hermesProfile: value.profile } : {}),
  }
}
