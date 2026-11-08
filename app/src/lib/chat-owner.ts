import { listsAsChat } from "./lists-as-chat.ts"
import type { Conversation, Profile } from "./db.ts"

/** A chat's row: the bot it is recorded on, and the project session it is, if it is one. */
export type ChatRow = Pick<Conversation, "profileId" | "projectId">

/**
 * A chat row's owner: the bot a row belongs to, the bot that answers for it, and whether a chat list
 * draws the row. One place decides it so a room — whose owner is a Host, and whose answerer is one
 * of its members, resolved when the row is read — extends this rule instead of every site that draws
 * a row (ADR 0115). Today every row is a chat, so its answerer is the bot it was recorded on.
 *
 * `bots` is the device's whole profile table, so a row whose bot was turned off in Gots goes unlisted
 * while a row this device holds no record of stays. A screen that names no bots gets the row's own
 * answer, which is what a pane opening an address needs: that chat is still reachable there.
 */
export function chatOwner(
  row: ChatRow,
  bots?: Map<string, Profile>,
): { bot: Profile | undefined; listed: boolean; answerer: string | undefined } {
  const bot = bots?.get(row.profileId)
  const listed = listsAsChat(row) && !bot?.disabled
  return { bot, listed, answerer: listed ? row.profileId : undefined }
}
