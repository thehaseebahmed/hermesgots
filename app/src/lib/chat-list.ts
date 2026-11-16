/**
 * A bot's chat list as a rule: what one row says, the order the rows are drawn in, what a search keeps
 * and how many pins the list holds. The screen draws exactly this (`routes/bot-chats.tsx`), and the
 * sidebar's bot rows and this list read one bot's chats, so the row's shape lives here rather than in
 * either of them.
 *
 * A row's line is the last thing the reader was told: the bot's newest words, and the reader's own only
 * while the bot has not answered them yet, because what they typed is not news to them. Its time is that
 * same arrival — the newest message the bot sent — because the list is ordered by what came *in*, and a
 * chat the reader has just spoken in is not one that has said anything since: it keeps the bot's last
 * word as its line and sits where that word put it. A bot that has said nothing in a chat yet keeps the
 * record's own clock and draws no line, and so does a row past `BOT_CHATS`, whose tail no screen reads.
 */
import { filterByFuzzy } from "./fuzzy.ts"
import { isUnread } from "./session-work.ts"
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

/**
 * The fields a chat's record is judged by before it is drawn as a row: the three kinds the rule never
 * touches, the two clocks it compares, and the mark a saved draft leaves.
 */
export interface ChatStanding {
  /** The bot's own Main thread, which is permanent and never hidden. */
  main?: boolean
  /** A room: nobody's chat, and a row of its own kind (ADR 0115). */
  room?: unknown
  /** A routine's run, whose line and time are written onto the record by the delivery. */
  routine?: boolean
  createdAt: number
  updatedAt: number
  /** When the reader saved a draft in it — the mark, and the text, every device sees (`draftAt`). */
  draftAt?: number
}

/**
 * Whether a chat is a row of a list at all (ADR 0158).
 *
 * A chat nothing has been said in is no row. The record a New chat press mints has `updatedAt` level
 * with its `createdAt`, and the pair stays level until something is sent in it — so a reader who opens
 * a chat, says nothing and steps back must find the list they left, not a row for a chat that never
 * started. It is a row the moment it holds something: a word sent in it (the clocks part), a saved
 * draft the record carries (`draftAt`, which syncs), or unsent text this device is holding for it —
 * `hasDraft`, which the caller asks of `drafts.ts`'s `unsentAmong` over the queue as well as the kept
 * drafts, since a keystroke not yet flushed has still started the chat.
 *
 * Three kinds are never judged by it. A bot's **Main** thread is permanent, and a bot that had not yet
 * said anything in it would otherwise open on a list with no way in. A **room** and a **run** are not
 * chats at all: a room's record is the Host's and arrives with its own clock, and a run's line and
 * time are the delivery's, its words living in the run's own session rather than here.
 *
 * This is a listing rule and nothing more. Nothing is deleted and no screen closes: a chat already
 * open keeps drawing from its record by id, and its row comes back on the first message or the first
 * draft kept.
 */
export function isListed(chat: ChatStanding, hasDraft: boolean): boolean {
  if (chat.main || chat.room || chat.routine) return true
  return chat.updatedAt > chat.createdAt || chat.draftAt !== undefined || hasDraft
}

/**
 * The marks a reader leaves on a row, as the record carries them: when it was pinned — which is what
 * orders the pinned group — and whether they archived it out of every list but the Archived pill. A
 * record written before a mark existed carries neither, and is read rather than migrated.
 */
export interface ChatMarks {
  pinnedAt?: number
  archived?: boolean
}

export type ChatRecord = Pick<
  Conversation,
  "id" | "title" | "pinned" | "updatedAt" | "routine" | "line" | "hermesSessionId"
> &
  ChatMarks

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
   * When the reader pinned it, so the pinned group reads the order the pins were made: the earliest on
   * top, the last pin at its bottom. Absent for a pin written before the app kept a clock, which reads
   * as the earliest and so keeps the top of the group — no stored pin is migrated to gain one.
   */
  pinnedAt?: number
  /**
   * Archived by the reader: the mark a list leaves the row out of every other pill by. Carried off the
   * record beside `pinned`, since a row is drawn from its record and from nothing else.
   */
  archived?: boolean
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
 * The marks a row carries from its record, so a row built by any list carries them the same way: each
 * is left off where the record says nothing, so a row states only the marks it really has.
 */
export function rowMarksOf(record: ChatMarks): ChatMarks {
  return {
    ...(record.pinnedAt !== undefined ? { pinnedAt: record.pinnedAt } : {}),
    ...(record.archived ? { archived: true } : {}),
  }
}

/**
 * One chat's row, from its record, the newest message this device holds for it and the newest *reply*
 * it holds. The line is the reply's words — the last thing the reader was told — and the reader's own
 * message stands in for it only while the bot has not answered them; `at` is that reply's, so the list
 * is ordered by what was received in it. A chat with no reply yet falls to its record's clock, since
 * nothing has arrived in it to date it by.
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
      ...rowMarksOf(chat),
      routine: true,
    }
  const reason = reply ? waitReasonOf(reply) : undefined
  return {
    id: chat.id,
    title: chat.title,
    line: plainLine((reply ?? newest)?.content ?? "") ?? NO_MESSAGES,
    at: reply?.createdAt ?? chat.updatedAt,
    pinned: Boolean(chat.pinned),
    ...rowMarksOf(chat),
    ...(chat.hermesSessionId ? { session: chat.hermesSessionId } : {}),
    // Nothing settled in a chat whose newest reply is still being written.
    ...(newest?.status === "streaming" ? { streaming: true } : {}),
    ...(reason ? { needs: reasonText(reason) } : {}),
  }
}

/**
 * A row's place in the list's one order: a pinned row first, then the pins in the order they were made
 * — `pinnedAt` ascending, so the earliest pin is on top and the last pin at the bottom of the group,
 * with a pin that carries no clock reading as the earliest. Pins made at one moment fall back to the
 * list's own rule, as does the whole unpinned band under them: what was last said in the row, newest
 * on top, ties by id so every device draws them alike. Named on its own so a list that draws the same
 * rows for another screen — the legacy layout's Rooms section — ranks them by the same rule.
 */
export function compareChatOrder(
  a: Pick<ChatListRow, "id" | "at" | "pinned" | "pinnedAt">,
  b: Pick<ChatListRow, "id" | "at" | "pinned" | "pinnedAt">,
): number {
  const band = Number(b.pinned) - Number(a.pinned)
  if (band) return band
  // Inside the pinned group: the moment the pin was made, and only the pins are ordered by it — an
  // unpinned row carries no clock, and one left behind by a record mid-merge cannot reorder its band.
  if (a.pinned) {
    const pin = (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0)
    if (pin) return pin
  }
  return b.at - a.at || (a.id < b.id ? -1 : 1)
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

/**
 * How many rows one bot's list may pin: the pinned group is read as one glance, so it is bounded —
 * and it is bounded per list, over the chats, rooms and runs drawn in it alike.
 */
export const PIN_LIMIT = 5

/**
 * The list's pins, in the order they were handed over — what the cap is counted from. A pinned row
 * the reader archived is no pin: archiving clears the pin in the same write, and a pin that
 * answered a merge from a device that had not archived yet sits behind the Archived pill, out of the
 * pinned group every list draws — so counting it would spend one of the five on a pin no reader sees.
 */
export function pinsOf(rows: readonly ChatListRow[]): ChatListRow[] {
  return rows.filter((row) => row.pinned && !row.archived)
}

/** What the Edit sheet's Pin switch says: whether this row is pinned, whether it may be turned, and
 * the line under it. */
export interface PinSwitch {
  checked: boolean
  disabled: boolean
  /** What the switch does while it may be turned, or what has to happen first while it may not. */
  subtitle: string
}

/** The line a switch wears while it is offered: what turning it on does. */
const PIN_SUBTITLE = "Stays at the top of its list, on every device."

/** The line a switch wears when the list holds its five, saying what has to happen first. */
const PIN_FULL_SUBTITLE = `Five pins is the most one list holds. Unpin one to make room.`

/**
 * The Pin switch on one row, read against the list it is drawn in: a pinned row is always turnable —
 * unpinning is what makes room — and an unpinned one is shut once the list holds `PIN_LIMIT` pins,
 * with the line under it saying so rather than leaving a reader to guess why.
 */
export function pinSwitchOf(
  row: Pick<ChatListRow, "pinned">,
  rows: readonly ChatListRow[],
): PinSwitch {
  const checked = Boolean(row.pinned)
  const full = !checked && pinsOf(rows).length >= PIN_LIMIT
  return { checked, disabled: full, subtitle: full ? PIN_FULL_SUBTITLE : PIN_SUBTITLE }
}

/**
 * The pills a bot's list narrows its rows by, in the order they stand. A filter only narrows: the one
 * pressed keeps the rows it names and the list's own order decides where they sit. Archived stands
 * straight after Unread because it is the one pill a reader reaches for after the rows that want
 * them: what they set aside is one press further on, and nowhere else.
 */
export type ChatFilter = "all" | "unread" | "archived" | "chats" | "rooms" | "routines"

/**
 * The pills, each with the words it wears and the sentence it says when it keeps nothing. The sentence
 * lives here rather than on the screen so a pill and its emptiness cannot be worded apart, the way the
 * search's own emptiness is `chatList`'s to keep. All's sentence is the list's emptiness with nothing
 * narrowing it, so an empty bot says "No chats yet." — and so does one whose every chat is archived —
 * while a pill holding nothing says its own.
 */
export const CHAT_FILTERS: readonly { key: ChatFilter; label: string; empty: string }[] = [
  { key: "all", label: "All", empty: "No chats yet." },
  { key: "unread", label: "Unread", empty: "No unread chats." },
  { key: "archived", label: "Archived", empty: "No archived chats." },
  { key: "chats", label: "Chats", empty: "No chats." },
  { key: "rooms", label: "Rooms", empty: "No rooms." },
  { key: "routines", label: "Routines", empty: "No routines." },
]

/** This device's read marks, as the rows' dots and the Unread pill both read them. */
export type ReadMarks = Record<string, number>

/**
 * What each pill keeps. The archive mark takes a row out of every pill but Archived — `all` included,
 * which is what keeps an archived row out of a search over any other pill, since the pill narrows
 * first and the search narrows what the pill kept. Unread is the row's own dot (`isUnread`, with the
 * same mark), Chats is a row that is neither a room nor a routine's run, and a room's and a run's are
 * the row's own markers — so the three kinds partition the rows nobody archived, and the pill, its
 * dot and its sentence cannot disagree.
 */
const KEEPS: Record<ChatFilter, (row: ChatListRow, marks: ReadMarks) => boolean> = {
  all: (row) => !row.archived,
  unread: (row, marks) => !row.archived && isUnread(row.at, marks[row.id]),
  archived: (row) => Boolean(row.archived),
  chats: (row) => !row.archived && !row.room && !row.routine,
  rooms: (row) => !row.archived && Boolean(row.room),
  routines: (row) => !row.archived && Boolean(row.routine),
}

/** The rows one pill keeps, in the order they were handed over. A filter never re-orders the list. */
export function filterChatRows(
  rows: readonly ChatListRow[],
  filter: ChatFilter,
  marks: ReadMarks,
): ChatListRow[] {
  return rows.filter((row) => KEEPS[filter](row, marks))
}

/** Whether a stored value is one of the pills, for a setting read off a device an older build wrote. */
export function isChatFilter(value: unknown): value is ChatFilter {
  return CHAT_FILTERS.some((entry) => entry.key === value)
}

/** What a pill says when it keeps nothing, by its key. */
export function emptyOf(filter: ChatFilter): string {
  return (CHAT_FILTERS.find((entry) => entry.key === filter) ?? CHAT_FILTERS[0]).empty
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
