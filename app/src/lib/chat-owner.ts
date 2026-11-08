import { listsAsChat } from "./lists-as-chat.ts"
import { roomAnswerer } from "./rooms.ts"
import type { Conversation, Profile } from "./db.ts"

/** A chat's row: the bot it is recorded on, the project session it is, and the room it may be. */
export type ChatRow = Pick<Conversation, "profileId" | "projectId" | "room">

/**
 * A chat row's owner: the bot a row belongs to, the bot that answers for it, and whether a chat list
 * draws the row. One place decides it so every site that draws a row asks the same question (ADR
 * 0115).
 *
 * `bots` is the device's whole profile table, so a row whose bot was turned off in Gots goes unlisted
 * while a row this device holds no record of stays. A screen that names no bots gets the row's own
 * answer, which is what a pane opening an address needs: that chat is still reachable there.
 *
 * A room is the row's own thing: it lists wherever a chat does — it is nobody's thread — and it
 * belongs to its Host rather than to the bot that carried the record, so the bot that answers for it
 * is resolved from its members, and `profileId` is bookkeeping.
 */
export function chatOwner(
  row: ChatRow,
  bots?: Map<string, Profile>,
): { bot: Profile | undefined; listed: boolean; answerer: string | undefined } {
  if (row.room) {
    const answerer = roomAnswerer(row.room, bots, bots?.get(row.profileId)?.hostId)
    return { bot: answerer, listed: true, answerer: answerer?.id }
  }
  const bot = bots?.get(row.profileId)
  const listed = listsAsChat(row) && !bot?.disabled
  return { bot, listed, answerer: listed ? row.profileId : undefined }
}
