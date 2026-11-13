/**
 * A bot's presence: whether its host is reaching it, and the words that say when it was last heard —
 * one rule and one sentence, because three screens ask the question and none of them may answer it
 * another way. Kept out of `registry.ts` and importing nothing but the app's own formatter, so
 * `scripts/test-presence.mjs` runs it as a pure rule, with no database, no React and no network: the
 * tier this belongs to, since what it decides is one derivation.
 *
 * Three things decide it: the bot (its host, whether it is hidden, and when this device last heard
 * it), this device's clock, and — where a caller has one — the answer the chat lists' own pass
 * recorded for the bot (`ChatStore` in `sync.ts`). An answer decides by itself: the plugin that
 * answered is online and one that didn't is away. With no answer — a launch whose first pass hasn't
 * landed yet — the last time this device heard the host decides against the window.
 */

import { formatRelative } from "./relative.ts"

/** A bot, as far as presence reads it. */
export interface PresenceBot {
  /** The linked host that registered it; unset for a bot added by hand. */
  hostId?: string
  /** Turned off in the app: hidden, and nothing checks on it. */
  disabled?: boolean
  /** When this device last heard the bot's host, off the pass that answered. */
  seenAt?: number
}

/**
 * What the sync lane's last chat-list pass answered for a bot: its Gots plugin answered, or it did
 * not. Declared here as the one thing this module reads it as, so presence imports no store; a
 * caller handing over `sync.ts`'s own `ChatStore` is held to this by `pnpm typecheck`.
 */
export type PresenceAnswer = "plugin" | "unreachable"

/**
 * How long this device's own last answer is trusted, while the chat-list pass that would replace it
 * hasn't landed: two missed heartbeats of the plugin that keeps a bot's host present, and a margin.
 * A pass normally lands inside a minute, so this covers a cold start or a tab that was paused, and
 * the pass's answer decides the moment it does. `scripts/test-presence.mjs` reads the plugin's own
 * `HEARTBEAT_SECONDS` and fails when the two drift apart, so the number cannot quietly outlive its
 * reason.
 */
export const ONLINE_MS = 25 * 60_000

/**
 * Whether this device has heard from the bot: the pass's answer where there is one, else the last
 * time it heard the host against the window. `undefined` where nothing has been heard at all — a
 * device that has heard from no host cannot call the bot away.
 */
function heard(bot: PresenceBot, now: number, answer?: PresenceAnswer): boolean | undefined {
  if (answer) return answer === "plugin"
  if (!bot.seenAt) return undefined
  return now - bot.seenAt < ONLINE_MS
}

/**
 * Whether this device can say the bot's host is reaching it: online, away, or `undefined` while the
 * bot is hidden, has no host, or has never been heard from. Settings says nothing about the same bot
 * an unknown here means nothing about, so a hidden bot never reads one way on one screen and another
 * way on the next.
 */
export function presence(
  bot: PresenceBot,
  now = Date.now(),
  answer?: PresenceAnswer,
): boolean | undefined {
  if (!bot.hostId || bot.disabled) return undefined
  // A pass that got no answer from a host this device has never heard says nothing it can place: the
  // bot is unknown to it, not away, which is the same silence Settings keeps about the same bot
  // (`presenceLine`). Only a sighting of some kind lets a failed pass read as `Offline`.
  if (answer === "unreachable" && !bot.seenAt) return undefined
  return heard(bot, now, answer)
}

/**
 * When the bot was last heard, in the app's words: `Online` while it is, `Last seen 2 hr. ago` once it
 * isn't, and nothing where this device has never heard from it at all — a screen that has something
 * of its own to say there (`Not seen yet` on a bot's Enabled row) says it, and no screen composes the
 * sentence itself.
 *
 * It reads what was heard and nothing else, so a bot with no host or hidden still has a sentence:
 * Settings' row drops it for either, and a bot's Enabled row says `Hidden in Gots` for a hidden one.
 * `presence` is where "nothing this device can answer for" lives, for the dot and the preview line
 * that cannot say anything else.
 */
export function presenceLine(
  bot: PresenceBot,
  now = Date.now(),
  answer?: PresenceAnswer,
): string | undefined {
  const online = heard(bot, now, answer)
  if (online === undefined) return undefined
  if (online) return "Online"
  if (!bot.seenAt) return undefined
  return `Last seen ${formatRelative(bot.seenAt, Math.max(now, bot.seenAt))}`
}
