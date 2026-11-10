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

/** The chat record a row is read from. */
export type ChatRecord = Pick<Conversation, "id" | "title" | "pinned" | "updatedAt">

/** The newest message this device holds for a chat: its words, its time, and anything it waits on. */
export type ChatTail = Pick<Message, "content" | "createdAt" | "clarify" | "approval">

/**
 * One row of a bot's chat list: the chat's title, the newest thing said in it cut to a line, the clock
 * the row is ordered and aged by, and whether a reply in it is waiting on the reader.
 */
export interface ChatListRow {
  id: string
  title: string
  line?: string
  at: number
  pinned: boolean
  waiting: boolean
}

/** Whether the newest reply in a chat asked the reader something they have not answered. */
function waitsOnUser(newest: ChatTail | undefined): boolean {
  if (!newest) return false
  if (newest.clarify && !newest.clarify.resolved) return true
  return Boolean(newest.approval && !newest.approval.resolved)
}

/** One chat's row, from its record and the newest message this device holds for it. */
export function chatRowOf(chat: ChatRecord, newest?: ChatTail): ChatListRow {
  return {
    id: chat.id,
    title: chat.title,
    line: newest ? oneLine(newest.content) : undefined,
    at: newest?.createdAt ?? chat.updatedAt,
    pinned: Boolean(chat.pinned),
    waiting: waitsOnUser(newest),
  }
}

/**
 * The list's one order: a pinned chat first, then by what was last said in it, newest on top. One
 * flat band — a second ordering rule would move rows under the reader. Ties keep one order on every
 * device, by id.
 */
export function orderChatRows(rows: readonly ChatListRow[]): ChatListRow[] {
  return [...rows].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at || (a.id < b.id ? -1 : 1),
  )
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

/**
 * How old a row is, as the list says it: how long ago within the day, and the date itself beyond
 * that, since "3 days ago" is not what a reader wants off a list they scan down.
 */
export function chatAge(at: number, now: number) {
  if (now - at >= DAY_MS)
    return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
  const seconds = Math.round((at - now) / 1000)
  if (Math.abs(seconds) >= 3_600) return relative.format(Math.round(seconds / 3_600), "hour")
  if (Math.abs(seconds) >= 60) return relative.format(Math.round(seconds / 60), "minute")
  return relative.format(seconds, "second")
}
