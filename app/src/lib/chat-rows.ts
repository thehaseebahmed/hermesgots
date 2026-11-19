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
  lineOf,
  shownSideChats,
  type ChatFilter,
  type ChatListRow,
  type ChatRecord,
} from "@/lib/chat-list"
import { drawnWordsOf } from "@/chat-next/fold"
import { opensOnChatNext } from "@/chat-next/route"
import {
  conversationsOf,
  db,
  isReply,
  mainChatOf,
  newestMessage,
  newestSessionRow,
  type Conversation,
  type Profile,
  type SessionRow,
} from "@/lib/db"
import { draftKey, unsentAmong } from "@/lib/drafts"
import { listsAsChat } from "@/lib/lists-as-chat"
import { useReadMarks } from "@/lib/read-marks"
import { useRoomNeeds, type RoomNeedsRow } from "@/lib/room"
import { roomRowOf } from "@/lib/rooms"
import { isUnread } from "@/lib/session-work"

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
 * Whether one of a session's rows is one a chat's line may be read off: the thread draws words of it
 * — the fold's own rule, shared so a row can only say what the thread says — and they are not blank.
 */
const isSaidRow = (row: SessionRow["row"]) => Boolean(drawnWordsOf(row).trim())

/** Whether a session's row is the bot's own words. */
const saidByBot = (row: SessionRow["row"]) => row.role === "assistant" && isSaidRow(row)

/**
 * The line a chat's own session gives its row: the newest row the bot wrote, and where the bot has
 * not answered yet the newest row of either role — the reader's own, which is the line a chat holds
 * while the answer is still out. `undefined` where the session holds no such row, which is a chat
 * this device has never opened.
 */
async function sessionLineOf(chat: Conversation): Promise<string | undefined> {
  if (!chat.hermesSessionId) return undefined
  const reply = await newestSessionRow(chat.hermesSessionId, saidByBot)
  const last = reply ?? (await newestSessionRow(chat.hermesSessionId, isSaidRow))
  return last ? drawnWordsOf(last.row) : undefined
}

/**
 * One chat's row, with its tail read where the bound put it: a routine's row reads its line and time
 * off the record, so its tail isn't asked for at all.
 *
 * The read that dates the row is the newest message of *either* role, so the row's other clock —
 * `latest`, which the Side Chat List lists by — is stamped off the same read and costs nothing extra.
 * A row the bound left unread carries neither, and a list orders it by the record's own clock.
 *
 * Where the bot can be called, the chat's own screen is chat-next (ADR 0065), whose one writer keeps
 * the thread's rows in `sessionRows` and never in `db.messages`, so the line is read off that
 * session's rows and the message read is not made at all. That read sits in the caller's live query
 * beside the one below it, so a reply landing wakes the row that says it. Every clock stays the
 * record's — the one chat-next bumps for a list row, and the one the thread's read mark rides — since
 * the line is the only thing the session read changes.
 */
async function rowOfChat(
  chat: Conversation,
  tailed: ReadonlySet<string>,
  bot: Profile | null,
): Promise<ChatListRow> {
  if (chat.routine || !tailed.has(chat.id)) return chatRowOf(chat)
  // The row reads the store the chat's own screen reads, by the question that screen is opened with
  // (`opensOnChatNext`): chat-next's session rows where the bot can be called, `db.messages` where it
  // cannot. A bot that loses its server moves the same record onto the screen that is the one writer
  // of `messages`, and the newest words the device holds are the ones the row must say — so the
  // session is not asked first, it is asked where it is the store being read.
  if (opensOnChatNext(chat, bot)) {
    const said = await sessionLineOf(chat)
    if (said !== undefined) return { ...chatRowOf(chat), line: lineOf(said) }
  }
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
    return (await mainChatOf(profileId))?.id ?? null
  }, [profileId])
}

/** What a badge counts of one chat's record: the side-chat marks, and the clock an arrival moves. */
function badgeMarkOf(chat: Conversation) {
  return {
    id: chat.id,
    main: chat.main,
    routine: chat.routine,
    archived: chat.archived,
    at: chat.updatedAt,
  }
}

/**
 * Whether any of a bot's side chats is unread: Main's one control in the bar is badged by this and
 * nothing else.
 *
 * A query of its own, and not the list's rows (`useBotRows`): the control stands in Main's bar while a
 * reply streams into the thread under it, and every flush writes `db.messages` — a badge that read the
 * rows would re-run one index read per tailed chat on each of those writes, for a dot. So it reads the
 * bot's chat records and this device's read marks, and compares the record's own `updatedAt`, which is
 * the clock an arrival moves (the reply flush updates the record) and the one a read mark is written
 * against when the thread renders. No `messages`, no rooms poller, no row: a room's news is not a
 * chat's, and the list is where its rows are read.
 */
export function useSideChatsUnread(profileId: string): boolean {
  const marks = useReadMarks()
  return (
    useLiveQuery(async () => {
      if (!profileId) return false
      const chats = await readBotChats(profileId)
      return shownSideChats(chats.map(badgeMarkOf)).some((chat) =>
        isUnread(chat.at, marks[chat.id]),
      )
    }, [profileId, marks]) ?? false
  )
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
    const rows = await Promise.all(chats.map((chat) => rowOfChat(chat, tailed, bot)))
    return { profileId, bot, rows }
  }, [profileId, filter])
}

/**
 * One bot's rows as its list draws them: the chats it holds, each dated by what arrived in it, and
 * the rooms its roster seats — one list, composed here rather than by each screen that draws them.
 *
 * They are **not ordered**: the list applies the clock it is drawn by (`chatList`, `ChatClock`), which
 * is the one place an order is decided. Both of a row's clocks ride the tail read, so a list that
 * orders by `latest` needs no second query and the reader's order is never the one a sort here has
 * already spent.
 */
export function useBotRows(profileId: string, filter?: ChatFilter): BotChats | undefined {
  const answer = useBotChats(profileId, filter)
  // The rooms this device lists, read by their membership: a room belongs to its Host and lists in
  // every bot its roster seats, whatever bot carried the record here (ADR 0115).
  const rooms = useRoomNeeds()
  // The answer names the address it ran for, so one bot's answer can never pass for another's.
  const fresh = answer && answer.profileId === profileId ? answer : undefined
  return useMemo(
    () => (fresh ? { ...fresh, rows: [...fresh.rows, ...seatedRoomRows(rooms ?? [], profileId)] } : undefined),
    [fresh, rooms, profileId],
  )
}
