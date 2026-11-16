/**
 * One bot's chats: the query its list and the sidebar both read, the bound on the tails that are read,
 * and the row each chat draws as. It was written twice — once for the list, once for the sidebar's
 * count — and only one copy knew that a pinned chat's tail is read wherever its clock puts it, so the
 * rule lives here and both ask it (`routes/bot-chats.tsx`, `useBotSummaries` in `threads.ts`).
 *
 * Rooms are not these rows: a room belongs to its Host and lists in every bot its roster seats, so
 * each screen merges the rooms it seats itself (ADR 0115).
 */
import { useLiveQuery } from "dexie-react-hooks"

import { BOT_CHATS, chatRowOf, type ChatListRow, type ChatRecord } from "@/lib/chat-list"
import {
  conversationsOf,
  db,
  isReply,
  newestMessage,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { listsAsChat } from "@/lib/lists-as-chat"

/**
 * Every chat the bot has, newest first. Every one of them is a row of its list — a chat older than any
 * bound is still one, since a bound is not something a reader can see (ADR 0136) — and a room, a
 * coding session or a canvas is no chat of the bot's at all.
 */
export function readBotChats(profileId: string): Promise<Conversation[]> {
  return conversationsOf(profileId).reverse().filter(listsAsChat).toArray()
}

/**
 * The chats whose newest message is read: the newest `BOT_CHATS`, every pinned one — a pin is the
 * reader's own word that the chat matters, wherever its clock puts it — and every archived one, since
 * the Archived pill draws those rows' lines and ages and no other pill draws them at all. A row past
 * this bound draws its title and age from the record alone.
 */
export function tailedIds(chats: readonly ChatRecord[]): Set<string> {
  return new Set(
    [...chats.slice(0, BOT_CHATS), ...chats.filter((chat) => chat.pinned || chat.archived)].map(
      (chat) => chat.id,
    ),
  )
}

/**
 * The newest message in a chat that the bot sent — the only row a question or an approval sits on, so
 * it is what a row's wait and a bot's own count are both read from.
 */
export function newestReplyOf(chatId: string) {
  return newestMessage(chatId, isReply)
}

/**
 * One chat's row, with its tail read where the bound put it: a routine's row reads its line and time
 * off the record, so its tail isn't asked for at all.
 */
async function rowOfChat(chat: Conversation, tailed: ReadonlySet<string>): Promise<ChatListRow> {
  if (chat.routine || !tailed.has(chat.id)) return chatRowOf(chat)
  const newest = await newestMessage(chat.id)
  // The row says what the bot last said, and a question or an approval sits on a reply: a read of the
  // newest message that already is one answers both, and one that is the reader's own asks for the
  // reply above it.
  const reply = !newest || isReply(newest) ? newest : await newestReplyOf(chat.id)
  return chatRowOf(chat, newest, reply)
}

/** What one bot's list is drawn from: the address the answer ran for, the bot, and its rows. */
export interface BotChats {
  /** The address this answer was read for, so one bot's answer can never pass for another's. */
  profileId: string
  /** The bot itself, or nothing where it is gone — deleted here or on another device. */
  bot: Profile | null
  rows: ChatListRow[]
}

/**
 * A bot's chats as its list draws them, read live, each row dated by the newest reply the bot sent.
 * The answer names the address it ran for, so a screen that has moved to another bot draws nothing
 * rather than this bot's rows under its name.
 */
export function useBotChats(profileId: string): BotChats | undefined {
  return useLiveQuery(async (): Promise<BotChats> => {
    const bot = (await db.profiles.get(profileId)) ?? null
    if (!bot) return { profileId, bot, rows: [] }
    const chats = await readBotChats(profileId)
    const tailed = tailedIds(chats)
    const rows = await Promise.all(chats.map((chat) => rowOfChat(chat, tailed)))
    return { profileId, bot, rows }
  }, [profileId])
}
