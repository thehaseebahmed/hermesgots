/**
 * One bot's chats as a list draws them: the query its list and the sidebar both read, the bound on the
 * tails that are read, the row each chat draws as, and the rooms the list seats (ADR 0115).
 */
import { useLiveQuery } from "dexie-react-hooks"
import { useMemo } from "react"

import {
  BOT_CHATS,
  chatRowOf,
  isListed,
  orderChatRows,
  type ChatClock,
  type ChatFilter,
  type ChatListRow,
  type ChatRecord,
} from "@/lib/chat-list"
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
import { useRoomNeeds, type RoomNeedsRow } from "@/lib/room"
import { roomRowOf } from "@/lib/rooms"

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
 * The chats among these that a list draws: the rule asked of each record first, and the rows it would
 * drop then asked of this device — their drafts in one read and their messages in one more — since a
 * chat this device holds a typed word or a message for has started (ADR 0158).
 *
 * It takes the records a screen has already queried, so a screen with a query of its own — the legacy
 * sidebar's Recents — applies the same rule and the same two reads instead of growing a copy of them.
 * Both reads happen in the caller's live query, so `db.drafts` (and `db.messages`) are dependencies of
 * it: a draft landing or being cleared wakes the list, which is what makes the row appear and go.
 */
export async function listingChats(chats: readonly Conversation[]): Promise<Conversation[]> {
  const doubted = chats.filter((chat) => !isListed(chat))
  if (!doubted.length) return [...chats]
  // The two device reads at once: neither needs the other's answer, and a list waits on both.
  const [unsent, spoken] = await Promise.all([
    unsentAmong(doubted.map((chat) => draftKey(chat.id))),
    spokenChats(doubted.map((chat) => chat.id)),
  ])
  const dropped = new Set(doubted.map((chat) => chat.id))
  return chats.filter(
    (chat) => !dropped.has(chat.id) || unsent.has(draftKey(chat.id)) || spoken.has(chat.id),
  )
}

/**
 * The chats this bot's list draws, newest first: every chat it has, less the ones nothing has been said
 * in and no draft is holding (ADR 0158) — `listingChats`' rule, over this bot's own query.
 */
export async function readListedChats(profileId: string): Promise<Conversation[]> {
  return listingChats(await readBotChats(profileId))
}

/**
 * The chats whose newest message is read: the newest `BOT_CHATS`, and every pinned one — a pin is the
 * reader's own word that the chat matters, wherever its clock puts it. An archived one is read too
 * where `filter` says the list is drawing the Archived pill, since that is the one pill that draws the
 * rows' lines and ages; with no `filter` given, every archived row is read, as the sidebar and the
 * other callers have always read them. A row past this bound draws its title and age from the record
 * alone.
 */
export function tailedIds(chats: readonly ChatRecord[], filter?: ChatFilter): Set<string> {
  const archived = filter === undefined || filter === "archived"
  return new Set(
    [
      ...chats.slice(0, BOT_CHATS),
      ...chats.filter((chat) => chat.pinned || (archived && chat.archived)),
    ].map((chat) => chat.id),
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
 *
 * The read that dates the row is the newest message of *either* role, so the row's other clock —
 * `latest`, which the Side Chat List lists by — is stamped off the same read and costs nothing extra.
 * A row the bound left unread carries neither, and a list orders it by the record's own clock.
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

/**
 * The rooms one bot's list seats, as rows: a room is nobody's chat, and it lists in every bot its
 * roster seats (ADR 0115), so `useBotRows` adds the rooms this device read to the chats it holds and
 * `chat-marks` counts a list's pins over both — a row written twice is a row that parts ways.
 */
export function seatedRoomRows(rooms: readonly RoomNeedsRow[], profileId: string): ChatListRow[] {
  return rooms
    .filter((room) => room.seated.includes(profileId))
    .map((room) => roomRowOf(room.chat, room.faces, room.said))
}

/**
 * The chat this device holds as one bot's **Main**: the one record carrying the flag the plugin
 * publishes, read live.
 *
 * `undefined` until the query answers — a screen draws nothing rather than a guess while it is out —
 * and `null` where the bot has none, which is a device that has never met a plugin publishing one.
 */
export function useBotMain(profileId: string): string | null | undefined {
  return useLiveQuery(async () => {
    if (!profileId) return null
    const main = await conversationsOf(profileId)
      .filter((chat) => Boolean(chat.main))
      .first()
    return main?.id ?? null
  }, [profileId])
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
 * The chats this bot's list draws, newest first, read live, each row dated by the newest reply the
 * bot sent — and carrying `latest`, the newest message of either role, off the same tail read, so a
 * caller that lists them by when the chat last moved at all needs no second query. The rooms its
 * roster seats are `useBotRows`'s to add: a screen reads its rows through that one door, so no screen
 * builds a list of its own.
 *
 * The answer names the address it ran for, so a screen that has moved to another bot draws nothing
 * rather than this bot's rows under its name.
 *
 * `filter` is the pill the screen has pressed, and it is what the tail read is widened by: rows the
 * Archived pill draws are read only while that pill is the one pressed, and no other pill reads a tail
 * it will not draw.
 */
function useBotChats(profileId: string, filter?: ChatFilter): BotChats | undefined {
  return useLiveQuery(async (): Promise<BotChats> => {
    const bot = (await db.profiles.get(profileId)) ?? null
    if (!bot) return { profileId, bot, rows: [] }
    // The chats its list draws — a chat nothing has been said in and no draft is holding is no row
    // (ADR 0158) — so a row left behind by a chat that never started is never drawn.
    const chats = await readListedChats(profileId)
    const tailed = tailedIds(chats, filter)
    const rows = await Promise.all(chats.map((chat) => rowOfChat(chat, tailed)))
    return { profileId, bot, rows }
  }, [profileId, filter])
}

/**
 * One bot's rows as its list draws them: the chats it holds, each dated by what arrived in it, and
 * the rooms its roster seats — one list, one order, composed here rather than by each screen that
 * draws them.
 *
 * `clock` is the order its caller lists them in (`ChatClock`): the flat layout takes the default, the
 * received one it has always drawn, and the Side Chat List asks for `latest` so the chat the reader has
 * just written in stands where they are. Both clocks are on the rows already — the one tail read
 * answers for both — so asking for the other orders the list without reading anything again.
 */
export function useBotRows(
  profileId: string,
  filter?: ChatFilter,
  clock: ChatClock = "at",
): BotChats | undefined {
  const answer = useBotChats(profileId, filter)
  // The rooms this device lists, read by their membership: a room belongs to its Host and lists in
  // every bot its roster seats, whatever bot carried the record here (ADR 0115).
  const rooms = useRoomNeeds()
  // The answer names the address it ran for, so one bot's answer can never pass for another's.
  const fresh = answer && answer.profileId === profileId ? answer : undefined
  return useMemo(
    () =>
      fresh
        ? {
            ...fresh,
            rows: orderChatRows(
              [...fresh.rows, ...seatedRoomRows(rooms ?? [], profileId)],
              clock,
            ),
          }
        : undefined,
    [fresh, rooms, profileId, clock],
  )
}
