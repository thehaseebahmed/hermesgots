/**
 * What an `@` menu may offer, read off this device: the sessions of the bot the message is going to,
 * and the other bots its host registered.
 *
 * Nothing here asks a host. A bot can only follow up on its own sessions, so no other bot's chat is
 * offered, and a bot on another host cannot be resolved by the host receiving the message, so only
 * the bots sharing this one's `hostId` are. A session with no title has no name to put in the
 * sentence, a canvas's session belongs to its canvas, and naming the chat you are already in says
 * nothing — all three are left out. The newest eight sessions are enough to fill the room above a
 * phone's keyboard, with the bots under them.
 *
 * The read is a live query gated on a token standing, not a poll: it is this device's own rows, so a
 * session renamed in another tab or a bot just linked is there the moment it is written, and nothing
 * has to stay true while the app is closed.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { conversationsOf, db, NEW_CHAT_TITLE, type Profile } from "./db"
import { mentionName } from "./mention"
import type { Mention } from "./mention-marker"
import { quietly } from "./report"

/** How many rows an unfiltered menu draws: what fits the room above a phone's keyboard. */
export const MENU_ROWS = 8

/** One row the menu draws: what a pick writes, and the one word under it saying what it is. */
export interface MentionRow extends Mention {
  /** `Session` or `Bot`, the one line the row shows under its name. */
  line: string
}

/**
 * The rows an `@` menu offers. Nothing is read while no token stands, and a bot that isn't there
 * offers nothing at all — there is no state in between to draw, since these rows are this device's
 * own and an open menu is only ever drawn over one of them.
 */
export function useMentionRows(
  bot: Profile | undefined,
  here: string | undefined,
  open: boolean,
): MentionRow[] {
  const id = bot?.id
  const host = bot?.hostId
  const read = useLiveQuery(async () => {
    if (!open || !id) return []
    const [sessions, bots] = await Promise.all([sessionsOf(id, here), botsOf(id, host)])
    return [...sessions, ...bots]
  }, [id, host, here, open])
  return open && bot ? (read ?? []) : []
}

/**
 * Every session of the bot's that can be named, newest first — not just the newest few: the menu
 * draws a handful while nothing is typed and searches the whole list behind a query, so a session
 * from months ago is reachable by its name. A read that fails leaves the bots that answered
 * standing rather than taking the whole menu down with it.
 */
async function sessionsOf(profileId: string, here: string | undefined): Promise<MentionRow[]> {
  // The exclusions run per row as the index hands it over, so the partition is walked once, and
  // only the rows a reader could name are materialised.
  const chats = await conversationsOf(profileId)
    .reverse()
    .filter(
      (chat) =>
        Boolean(chat.title.trim()) &&
        // A chat nobody has said anything in wears the default title, so there is nothing in it to
        // name; one the reader renamed to those same words is theirs and stays.
        (chat.title !== NEW_CHAT_TITLE || Boolean(chat.titleEdited)) &&
        !chat.canvasId &&
        chat.id !== here,
    )
    .toArray()
    .catch(quietly("Reading the sessions that may be mentioned"))
  return (chats ?? []).map((chat) => ({
    name: mentionName(chat.title),
    kind: "session" as const,
    id: chat.hermesSessionId,
    line: "Session",
  }))
}

/** The other bots on this bot's host, less the ones turned off. A bot added by hand has no host. */
async function botsOf(profileId: string, hostId: string | undefined): Promise<MentionRow[]> {
  if (!hostId) return []
  // Only a bot its host can name is offered: the line written for it carries the profile its host
  // knows, and a bot added by hand has only the name this device shows it by.
  const bots = await db.profiles
    .filter((one) => one.hostId === hostId && one.id !== profileId && !one.disabled)
    .toArray()
    .catch(quietly("Reading the bots that may be mentioned"))
  return (bots ?? []).flatMap((one) =>
    one.hermesProfile
      ? [{ name: one.name, kind: "bot" as const, id: one.hermesProfile, line: "Bot" }]
      : [],
  )
}
