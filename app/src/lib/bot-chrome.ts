/**
 * What the sidebar's bot row says under its name: the bot's state, never a chat's words, and never
 * nothing at all (ADR 0151). A row that said nothing read as a row that had failed to load.
 *
 * Something unread is said first, because it is the fact a reader can act on, and it counts the bot's
 * conversations rather than their messages — one row of its list, one. With nothing unread the line
 * says whether its host is checking in, and where this device cannot answer for it, what is missing:
 * `Not linked` for a bot no host registered, and `Not seen yet` for a linked host nothing has been
 * heard from. Those are the words the rest of the app already uses for the same two bots — Settings'
 * Enabled row says `Not seen yet`, and its last row is `Link a bot` — so a reader meets one
 * vocabulary rather than one per screen. Neither is `Offline`: a bot this device cannot place is not
 * a bot it has watched go quiet.
 */
import { presence, type PresenceAnswer, type PresenceBot } from "./presence.ts"

export function stateLine({
  unread,
  bot,
  now,
  answer,
}: {
  /** How many of the bot's conversations this device holds past its read mark. */
  unread: number
  /** The bot itself: its host, and when this device last heard from it. */
  bot: PresenceBot
  now: number
  /** The chat-list pass's answer for the bot, where one has run. */
  answer?: PresenceAnswer
}): string {
  if (unread > 0) return `${unread} unread`
  if (!bot.hostId) return "Not linked"
  // A bot turned off in Gots is in no list at all (`listEnabledProfiles`), so the row never draws one
  // and says nothing about being hidden: `presence`'s third silence has no row to reach here.
  const online = presence(bot, now, answer)
  if (online === undefined) return "Not seen yet"
  return online ? "Online" : "Offline"
}
