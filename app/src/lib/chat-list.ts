/**
 * A bot's chat list as a rule: what one row says, the order the rows are drawn in, and what a search
 * keeps. The screen draws exactly this (`routes/bot-chats.tsx`), and the sidebar's bot rows and this
 * list read one bot's chats, so the row's shape lives here rather than in either of them.
 *
 * A row's line and its time are one read of the chat's newest message — nothing about a chat's tail
 * is synced onto its record for a list to draw. A bot that has said nothing in a chat yet keeps the
 * record's own clock and draws no line.
 */
import { filterByFuzzy } from "./fuzzy.ts"
import { oneLine } from "./words.ts"
import type { Conversation, Message } from "./db.ts"

/**
 * How many of a bot's newest chats one screen reads the tail of. Every chat the bot has is a row of
 * its list — a bound on the rows would put a chat out of reach — and a record is cheap; what a row
 * costs is the read of its newest message, which is what this bounds (`routes/bot-chats.tsx`, and the
 * sidebar's one preview read here too). A pinned chat's tail is read wherever its clock puts it.
 */
export const BOT_CHATS = 50

export type ChatRecord = Pick<
  Conversation,
  "id" | "title" | "pinned" | "updatedAt" | "routine" | "line"
>

export type ChatTail = Pick<Message, "content" | "createdAt" | "clarify" | "approval">

/**
 * A room is a row of this list like a chat: it wears its members' pictures where a chat wears its
 * bot's, and says what its own log ends asking the reader for, since a room has no tail on this
 * device to read (ADR 0115, ADR 0116).
 */
export interface ChatListRow {
  id: string
  title: string
  line?: string
  at: number
  pinned: boolean
  waiting: boolean
  /**
   * The run a routine's delivery is: its row wears the routine's icon rather than a chat's, and its
   * line and time are the record's, since the run's words are in the run's own session and this chat
   * holds no message at all.
   */
  routine?: boolean
  /** The room this row is, wearing its members' pictures: nothing at all for a chat (ADR 0126). */
  room?: { shown: string[]; more: number }
  /** The sentence a room's row says it needs the reader for, while its log ends asking. */
  needs?: string
}

/** Whether the newest reply in a chat asked the reader something they have not answered. */
export function waitsOnUser(newest: ChatTail | undefined): boolean {
  if (!newest) return false
  if (newest.clarify && !newest.clarify.resolved) return true
  return Boolean(newest.approval && !newest.approval.resolved)
}

/**
 * One chat's row, from its record and the newest message this device holds for it. `waits` is the row
 * a question or an approval can sit on, which is the newest *reply*: a list whose read is the newest
 * message of any role still asks this of the reply under the reader's own last message, or typing in
 * a chat would clear a mark the answer is still owed.
 */
export function chatRowOf(chat: ChatRecord, newest?: ChatTail, waits = newest): ChatListRow {
  if (chat.routine)
    return {
      id: chat.id,
      title: chat.title,
      line: chat.line,
      at: chat.updatedAt,
      pinned: Boolean(chat.pinned),
      waiting: false,
      routine: true,
    }
  return {
    id: chat.id,
    title: chat.title,
    line: newest ? oneLine(newest.content) : undefined,
    at: newest?.createdAt ?? chat.updatedAt,
    pinned: Boolean(chat.pinned),
    waiting: waitsOnUser(waits),
  }
}

/**
 * A row's place in the list's one order: a pinned row first, then by what was last said in it, newest
 * on top, ties by id so every device draws them alike. Named on its own so a list that draws the same
 * rows for another screen — the legacy layout's Rooms section — ranks them by the same rule.
 */
export function compareChatOrder(
  a: Pick<ChatListRow, "id" | "at" | "pinned">,
  b: Pick<ChatListRow, "id" | "at" | "pinned">,
): number {
  return Number(b.pinned) - Number(a.pinned) || b.at - a.at || (a.id < b.id ? -1 : 1)
}

/**
 * The list's one order, applied: one flat band — a second ordering rule would move rows under the
 * reader.
 */
export function orderChatRows(rows: readonly ChatListRow[]): ChatListRow[] {
  return [...rows].sort(compareChatOrder)
}

/**
 * The rows the list draws for a search: the order above, narrowed to the chats whose title or last
 * line answers the query through the matcher Code's list uses. A search narrows the list, it never
 * re-orders it.
 */
export function chatList(rows: readonly ChatListRow[], query: string): ChatListRow[] {
  return filterByFuzzy(orderChatRows(rows), query, (row) => [row.title, row.line])
}

const DAY_MS = 86_400_000
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" })
const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" })

/**
 * How old a row is, as the list says it: how long ago within the day, and the date itself beyond
 * that, since "3 days ago" is not what a reader wants off a list they scan down.
 *
 * The formatters are built once: a row asks this on every render, and a list holds fifty of them.
 */
export function chatAge(at: number, now: number) {
  if (now - at >= DAY_MS) return date.format(at)
  const seconds = Math.round((at - now) / 1000)
  if (Math.abs(seconds) >= 3_600) return relative.format(Math.round(seconds / 3_600), "hour")
  if (Math.abs(seconds) >= 60) return relative.format(Math.round(seconds / 60), "minute")
  return relative.format(seconds, "second")
}
