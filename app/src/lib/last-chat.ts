/**
 * The chat each bot was last in — what a bot's address opens on.
 *
 * A bot opens where the reader left it: the chat whose address was last on screen for that bot, kept
 * per bot in this device's storage alone and never synced, since it is where a reader was sitting
 * rather than a fact about the chat. A memory that no longer holds — the chat deleted, or one that
 * has come to belong to another bot — falls to the newest chat the bot has left, and a bot this
 * device has never opened has nothing to open at all, so its list is what draws.
 */
import { conversationsOf, db, type Conversation } from "./db.ts"
import { listsAsChat } from "./lists-as-chat.ts"

export const lastChatKey = (profileId: string) => `gots:last-chat:${profileId}`

/**
 * One of a bot's own chats: not a project session, a room, a canvas or a routine's run, whatever its
 * record holds. A run is read-only, so it is never the chat a bot opens on.
 */
const isChatOf = (chat: Conversation, profileId: string) =>
  chat.profileId === profileId && listsAsChat(chat) && !chat.routine

export function lastChatOf(profileId: string): string | null {
  try {
    return localStorage.getItem(lastChatKey(profileId))
  } catch {
    // Storage blocked: nothing is remembered, so a bot opens on its list.
    return null
  }
}

export function rememberLastChat(profileId: string, chat: string) {
  try {
    if (localStorage.getItem(lastChatKey(profileId)) !== chat)
      localStorage.setItem(lastChatKey(profileId), chat)
  } catch {
    // Storage blocked: the write is lost, so the bot opens on its list.
  }
}

/**
 * Where a bot's address opens: the chat this device last had open there while it is still one of the
 * bot's, else the newest chat the bot has left, else nothing at all — its list.
 */
export async function landingChat(profileId: string): Promise<string | undefined> {
  const kept = lastChatOf(profileId)
  if (!kept) return undefined
  const found = await db.conversations.get(kept)
  if (found && isChatOf(found, profileId)) return found.id
  const newest = await conversationsOf(profileId)
    .reverse()
    .filter((chat) => isChatOf(chat, profileId))
    .first()
  return newest?.id
}
