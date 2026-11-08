/**
 * What a device keeps from one bot's registry record, beside its address and key.
 *
 * A bot's **Hermes profile name** is the name its profile has on its host (`default`, `work`, ...),
 * and it is what a room's roster holds. The plugin seals it with the bot's address, so it arrives on
 * the same read; it stays on the device, like the rest of what one read finds out (ADR 0118).
 */
import type { Profile } from "@/lib/db"

export interface RegistryBotRecord {
  enabled: boolean
  seen?: { at: number; pluginVersion?: string }
}

export interface SealedBotRecord {
  /** Absent from a plugin too old to seal one. */
  profile?: string
  pluginVersion?: string
}

export type BotFields = Partial<
  Pick<Profile, "disabled" | "seenAt" | "pluginVersion" | "hermesProfile">
>

export function botFields(record: RegistryBotRecord, value: SealedBotRecord): BotFields {
  const fields: BotFields = {
    disabled: !record.enabled || undefined,
    seenAt: record.seen?.at,
    pluginVersion: record.seen?.pluginVersion ?? value.pluginVersion,
  }
  if (value.profile) fields.hermesProfile = value.profile
  return fields
}
