/**
 * A bot's chat list as a rule: what one row says, the order the rows are drawn in, and what a search
 * keeps. The screen draws exactly this (`routes/bot-chats.tsx`), and the sidebar's bot rows and this
 * list read one bot's chats, so the row's shape lives here rather than in either of them.
 *
 * A row's line is the last thing the reader was told: the bot's newest words, and the reader's own only
 * while the bot has not answered them yet, because what they typed is not news to them. Its time is the
 * chat's newest message of any role, which is when the chat last moved — a chat the reader has just
 * spoken in is at the top of the list, saying what the bot said last. A bot that has said nothing in a
 * chat yet keeps the record's own clock and draws no line.
 */
import { filterByFuzzy } from "./fuzzy.ts"
import { reasonText } from "./wait-text.ts"
import { NO_MESSAGES, plainLine } from "./words.ts"
import type { WaitingReason } from "./hermes.ts"
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
  "id" | "title" | "pinned" | "updatedAt" | "routine" | "line" | "hermesSessionId"
>

export type ChatTail = Pick<Message, "content" | "createdAt" | "clarify" | "approval" | "status">

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
  /**
   * The run a routine's delivery is: its row wears the routine's icon rather than a chat's, and its
   * line and time are the record's, since the run's words are in the run's own session and this chat
   * holds no message at all.
   */
  routine?: boolean
  /**
   * The room this row is, wearing its members' pictures: nothing at all for a chat (ADR 0126). `names`
   * is what the pictures cannot say to a reader who cannot see them, since the row's line is now the
   * last thing said in the room rather than the roster.
   */
  room?: { shown: string[]; more: number; names?: string }
  /**
   * The sentence a row says it needs the reader for, while it waits: a chat's own question or
   * approval, and a room's log ending addressed to them. It is drawn in the warning tone in place of
   * the line, the way Code's list says why a session waits, so a wait reads alike in every list.
   */
  needs?: string
  /**
   * The Hermes session this chat answers at, so the row can ask the host whether a run is in flight
   * for it — a run started on another device is invisible to this one's own messages.
   */
  session?: string
  /** This device's newest reply in the chat is still streaming: a run is in flight, here at least. */
  streaming?: boolean
}

/**
 * What a reply asks the reader for: its question's count, or the command it wants to run. `wait-text`
 * says the sentence, the same one Code's row says of the reason its bot's server reports, so the two
 * lists cannot word one wait differently.
 */
function waitReasonOf(tail: ChatTail): WaitingReason | undefined {
  if (tail.clarify && !tail.clarify.resolved)
    return { kind: "question", count: tail.clarify.questions.length }
  if (tail.approval && !tail.approval.resolved)
    return {
      kind: "approval",
      ...(tail.approval.command ? { command: tail.approval.command } : {}),
    }
  return undefined
}

/** Whether the newest reply in a chat asked the reader something they have not answered. */
export function waitsOnUser(newest: ChatTail | undefined): boolean {
  return Boolean(newest && waitReasonOf(newest))
}

/**
 * One chat's row, from its record, the newest message this device holds for it and the newest *reply*
 * it holds. The line is the reply's words — the last thing the reader was told — and the reader's own
 * message stands in for it only while the bot has not answered them; `at` stays the newest message's,
 * so a chat the reader has just spoken in is ordered by that and still says what the bot last said.
 *
 * `reply` is also the row a question or an approval can sit on, and it defaults to the newest message
 * for a caller that has only the one read: a list that reads the tail of any role still asks this of
 * the reply under the reader's own last message, or typing in a chat would clear a mark the answer is
 * still owed.
 */
export function chatRowOf(
  chat: ChatRecord,
  newest?: ChatTail,
  reply: ChatTail | undefined = newest,
): ChatListRow {
  if (chat.routine)
    return {
      id: chat.id,
      title: chat.title,
      line: chat.line,
      at: chat.updatedAt,
      pinned: Boolean(chat.pinned),
      routine: true,
    }
  const reason = reply ? waitReasonOf(reply) : undefined
  return {
    id: chat.id,
    title: chat.title,
    line: plainLine((reply ?? newest)?.content ?? "") ?? NO_MESSAGES,
    at: newest?.createdAt ?? chat.updatedAt,
    pinned: Boolean(chat.pinned),
    ...(chat.hermesSessionId ? { session: chat.hermesSessionId } : {}),
    // Nothing settled in a chat whose newest reply is still being written.
    ...(newest?.status === "streaming" ? { streaming: true } : {}),
    ...(reason ? { needs: reasonText(reason) } : {}),
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
