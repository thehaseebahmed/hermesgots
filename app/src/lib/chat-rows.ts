/**
 * One bot's chats: the query its list and the sidebar both read, the bound on the tails that are read,
 * and the row each chat draws as. It was written twice — once for the list, once for the sidebar's
 * count — and only one copy knew that a pinned chat's tail is read wherever its clock puts it, so the
 * rule lives here and both ask it (`routes/bot-chats.tsx`, `useBotSummaries` in `threads.ts`).
 *
 * It is also the one place a chat is judged a row at all: a chat nothing has been said in is no row
 * until it holds a word or a draft (`isListed` in `chat-list.ts`, ADR 0158), so the list and the
 * sidebar's preview cannot disagree about which chats a bot has.
 *
 * Rooms are not these rows: a room belongs to its Host and lists in every bot its roster seats, so
 * each screen merges the rooms it seats itself (ADR 0115).
 */
import { useLiveQuery } from "dexie-react-hooks"

import { BOT_CHATS, chatRowOf, isListed, type ChatListRow, type ChatRecord } from "@/lib/chat-list"
import {
  conversationsOf,
  db,
  isReply,
  newestMessage,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { draftKey, unsentAmong } from "@/lib/drafts"
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
 * The chats among these this device holds a message for. A record whose clock never moved is no proof
 * that nothing was said in it — a sync, an import or a host that answers without moving the record can
 * leave a chat's own words here while its record still reads as new — so a row with a message in it is
 * started, whatever its two clocks say.
 *
 * One read for every row the rule would drop, and only those rows are read: a chat in the set looks
 * unstarted, so in normal use it holds no message and the walk is empty.
 */
async function spokenChats(ids: readonly string[]): Promise<Set<string>> {
  const spoken = new Set<string>()
  if (!ids.length) return spoken
  await db.messages
    .where("conversationId")
    .anyOf([...ids])
    .each((message) => {
      spoken.add(message.conversationId)
    })
  return spoken
}

/**
 * The chats this bot's list draws, newest first: every chat it has, less the ones nothing has been said
 * in and no draft is holding (ADR 0158). The rule is asked of each record first, and the rows it would
 * drop are then asked of this device — their drafts in one read and their messages in one more — since
 * a chat this device holds a typed word or a message for has started.
 *
 * Both reads are inside the live query's own run, so `db.drafts` (and `db.messages`) are dependencies of
 * it: a draft landing or being cleared wakes the list, which is what makes the row appear and go.
 */
export async function readListedChats(profileId: string): Promise<Conversation[]> {
  const chats = await readBotChats(profileId)
  const doubted = chats.filter((chat) => !isListed(chat, false))
  if (!doubted.length) return chats
  const unsent = await unsentAmong(doubted.map((chat) => draftKey(chat.id)))
  const spoken = await spokenChats(doubted.map((chat) => chat.id))
  const dropped = new Set(doubted.map((chat) => chat.id))
  return chats.filter(
    (chat) => !dropped.has(chat.id) || unsent.has(draftKey(chat.id)) || spoken.has(chat.id),
  )
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
    // The chats its list draws — a chat nothing has been said in and no draft is holding is no row
    // (ADR 0158) — so a row left behind by a chat that never started is never drawn.
    const chats = await readListedChats(profileId)
    const tailed = tailedIds(chats)
    const rows = await Promise.all(chats.map((chat) => rowOfChat(chat, tailed)))
    return { profileId, bot, rows }
  }, [profileId])
}
