/**
 * A bot's chat list as a rule: what one row says, the order the rows are drawn in, what a search keeps
 * and how many pins the list holds. The screen draws exactly this (`components/chat/chat-list.tsx`),
 * and the sidebar's bot rows and this list read one bot's chats, so the row's shape lives here rather
 * than in either of them.
 *
 * A row's line is the last thing the reader was told: the bot's newest words, and the reader's own only
 * while the bot has not answered them yet, because what they typed is not news to them. Its time is that
 * same arrival — the newest message the bot sent — because the list is ordered by what came *in*, and a
 * chat the reader has just spoken in is not one that has said anything since: it keeps the bot's last
 * word as its line and sits where that word put it. A bot that has said nothing in a chat yet keeps the
 * record's own clock and draws no line, and so does a row past `BOT_CHATS`, whose tail no screen reads.
 *
 * A row carries a second clock beside that one — `latest`, the newest message of either role — which
 * rides the same tail read, so a list can be ordered by when a chat last moved at all without paying
 * for another read: the Side Chat List reads that one, because a chat the reader has just written in is
 * the one they are in, and the flat list keeps the received clock it has always drawn (`ChatClock`).
 *
 * A bot's **Main** is a row like any other, drawn at the app's own word (`MAIN_TITLE`) rather than the
 * host's title, and `sideChats` is the one rule for the rows a bot's screen lists beside it.
 */
import { formatDate } from "./format.ts"
import { filterByFuzzy } from "./fuzzy.ts"
import { isUnread } from "./session-work.ts"
import { reasonText } from "./wait-text.ts"
import { NO_MESSAGES, plainLine } from "./words.ts"
import type { WaitingReason } from "./hermes.ts"
import type { Conversation, Message } from "./db.ts"

/**
 * How many of a bot's newest chats one screen reads the tail of. Every chat the bot has is a row of
 * its list — a bound on the rows would put a chat out of reach — and a record is cheap; what a row
 * costs is the read of its newest message, which is what this bounds
 * (`components/chat/chat-list.tsx`, and the sidebar's one preview read here too). Two kinds have their
 * tail read wherever their clock puts them: a pinned chat, whose pin is the reader's own word that it
 * matters, and an archived one, whose line only the Archived pill draws.
 */
export const BOT_CHATS = 50

/**
 * The word the app draws on Main: a bot's one permanent conversation is the host's Bot Chat, whose
 * title is Hermes's, so the UI says its own word over it. A record that stops being Main reads as its
 * own thread rather than a second row called Main.
 */
export const MAIN_TITLE = "Main"

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
  /** Archived by the reader: put away, with the Archived pill the one way back to it. */
  archived?: boolean
  createdAt: number
  updatedAt: number
  /** When the reader saved a draft in it — the mark, and the text, every device sees (`draftAt`). */
  draftAt?: number
}

/**
 * Whether a chat has been started, as its own two clocks say: a word sent in it moves `updatedAt` past
 * the `createdAt` the New chat press minted it at. This is the one comparison `isListed` judges a chat
 * by, named on its own because a reader that must not ask about drafts — a screen leaving a chat
 * nothing was sent into — asks exactly this question and nothing else.
 */
export function hasStarted(chat: Pick<ChatStanding, "createdAt" | "updatedAt">): boolean {
  return chat.updatedAt > chat.createdAt
}

/**
 * Whether a chat is a row of a list at all (ADR 0158).
 *
 * A chat nothing has been said in is no row. The record a New chat press mints has `updatedAt` level
 * with its `createdAt`, and the pair stays level until something is sent in it — so a reader who opens
 * a chat, says nothing and steps back must find the list they left, not a row for a chat that never
 * started. It is a row the moment it holds something: a word sent in it (the clocks part) or a saved
 * draft the record carries (`draftAt`, which syncs).
 *
 * What only this device knows is the caller's to add and not this rule's to reach for: a keystroke
 * still in the queue, or a message a sync left behind a record that never moved, are `chat-rows.ts`'s
 * `listingChats`, which ORs its two device reads onto this answer.
 *
 * Three kinds are never judged by it. A bot's **Main** thread is permanent, and a bot that had not yet
 * said anything in it would otherwise open on a list with no way in. A **room** and a **run** are not
 * chats at all: a room's record is the Host's and arrives with its own clock, and a run's line and
 * time are the delivery's, its words living in the run's own session rather than here.
 *
 * A fourth exemption is the archive mark's own: archiving is an act the reader took, and the Archived
 * pill is the only way back to what it kept. A chat the New chat press minted and the reader
 * put away before saying a word would otherwise be reachable from nowhere at all.
 *
 * This is a listing rule and nothing more. Nothing is deleted and no screen closes: a chat already
 * open keeps drawing from its record by id, and its row comes back on the first message or the first
 * draft kept.
 */
export function isListed(chat: ChatStanding): boolean {
  if (chat.main || chat.room || chat.routine || chat.archived) return true
  return hasStarted(chat) || chat.draftAt !== undefined
}

/**
 * Whether a row may be put away at all: a conversation that exists may, and a chat nothing has been
 * said in may not, because putting it away would be the one thing that took it out of the sheet that
 * is its only way in. A row already archived is always offered the way back, whatever it holds.
 *
 * A bot's **Main** is never put away (G2): it is the bot's own conversation with its host, not a chat
 * the reader made and may set aside, so no surface is offered the press.
 */
export function mayArchive(chat: ChatStanding): boolean {
  if (chat.main) return false
  return Boolean(chat.archived) || isListed(chat)
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
  "id" | "title" | "pinned" | "updatedAt" | "routine" | "line" | "hermesSessionId" | "main"
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
  /**
   * The clock this row is ordered by when a list keeps the received one: the newest message the *bot*
   * sent, since a chat is as new as the last thing the reader was told. A row whose reply has not
   * arrived falls to the record's own clock.
   */
  at: number
  /**
   * The newest message of either role in the chat, where this device read its tail: a list that puts
   * the chat the reader has just written in where they are orders by this instead (`ChatClock`). It
   * rides the one tail read `at` comes from, so both clocks are on the row at no extra cost, and a row
   * past the bound — whose tail no screen read — carries none and is ordered by `at`.
   */
  latest?: number
  pinned: boolean
  /**
   * A bot's Main: its one permanent conversation with its host, drawn at `MAIN_TITLE` rather than the
   * record's own, and offered no pin, no archive and no delete anywhere (G2).
   */
  main?: boolean
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
 * lists cannot word one wait differently — and every reader of a wait asks this one function, so a
 * reason cannot be read one way by a row and another by a band.
 */
export function waitReasonOf(tail: ChatTail): WaitingReason | undefined {
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
 * A row's line from the words it says: one plain line, or the fallback where it says nothing. The
 * one rule every line is drawn by, whichever store the words were read from.
 */
export const lineOf = (words: string) => plainLine(words) ?? NO_MESSAGES

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
    // Main is the host's record with Hermes's title ("Bot Chat"); the app says its own word over it.
    title: chat.main ? MAIN_TITLE : chat.title,
    line: lineOf((reply ?? newest)?.content ?? ""),
    at: reply?.createdAt ?? chat.updatedAt,
    ...(newest ? { latest: newest.createdAt } : {}),
    pinned: Boolean(chat.pinned),
    ...rowMarksOf(chat),
    ...(chat.main ? { main: true } : {}),
    ...(chat.hermesSessionId ? { session: chat.hermesSessionId } : {}),
    // Nothing settled in a chat whose newest reply is still being written.
    ...(newest?.status === "streaming" ? { streaming: true } : {}),
    ...(reason ? { needs: reasonText(reason) } : {}),
  }
}

/**
 * What the side-chat rule reads of a row: a chat-list row, or the record-derived marks a badge is
 * counted from — the two clocks and the words are nobody's business of this rule's.
 */
type SidedRow = Pick<ChatListRow, "main" | "routine" | "archived">

/**
 * The rows a bot's screen lists as its side chats: one rule for the Side Chat List, its subtitle's
 * count and Main's badge, so no two of them can disagree about what a side chat is (G5).
 *
 * A side chat is a **chat** or a **room** that is neither Main nor a routine's run — the bot's Main is
 * the screen it is drawn from, and a run is the routines page's row, not a conversation of the bot's.
 * The archive is deliberately not this rule's: `keptBy`/`KEEPS` decide that, so a row the reader put
 * away is still a side chat and stands under the Archived pill, which is the only pill that draws it.
 * What a screen shows of these is `shownSideChats` below.
 */
export function sideChats<T extends SidedRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => !row.main && !row.routine)
}

/**
 * What a screen shows of a bot's side chats: `sideChats` less the ones the reader archived, which no
 * pill but Archived draws. The Side Chat List's subtitle counts these, Main's control is badged by
 * them, and the list's All pill draws them, so three surfaces cannot disagree about how many there are.
 */
export function shownSideChats<T extends SidedRow>(rows: readonly T[]): T[] {
  return sideChats(rows).filter((row) => !row.archived)
}

/**
 * The clock a list orders its rows by. `at` is what a bot's list of its chats has always been ordered
 * by — the newest word the bot sent, so a chat is as new as the last thing the reader was told — and
 * `latest` is the newest message of either role, which is the clock the Side Chat List reads: a chat
 * the reader has just written in is where they are, so it stands on top. The flat layout keeps `at`.
 *
 * The list is the one owner of this: `chatList` applies it as the rows are drawn, and no query that
 * answers rows orders them by a clock of its own, since a second order would be the one the reader
 * sees (ADR 0161).
 */
export type ChatClock = "at" | "latest"

/** A row's clock as the list asked for it: its `latest` where a tail was read, and its `at` otherwise. */
function clockOf(row: Pick<ChatListRow, "at" | "latest">, clock: ChatClock): number {
  return clock === "latest" ? (row.latest ?? row.at) : row.at
}

/**
 * A row's place in the list's one order: a pinned row first, then the pins in the order they were made
 * — `pinnedAt` ascending, so the earliest pin is on top and the last pin at the bottom of the group,
 * with a pin that carries no clock reading as the earliest. Pins made at one moment fall back to the
 * list's own rule, as does the whole unpinned band under them: what was last said in the row, newest
 * on top, ties by id so every device draws them alike. Named on its own so a list that draws the same
 * rows for another screen — the legacy layout's Rooms section — ranks them by the same rule.
 *
 * `clock` is the row's own time the band is read by (`ChatClock`): one rule for both lists, so the two
 * layouts cannot order the same rows two ways.
 */
export function compareChatOrder(
  a: Pick<ChatListRow, "id" | "at" | "latest" | "pinned" | "pinnedAt">,
  b: Pick<ChatListRow, "id" | "at" | "latest" | "pinned" | "pinnedAt">,
  clock: ChatClock = "at",
): number {
  const band = Number(b.pinned) - Number(a.pinned)
  if (band) return band
  if (a.pinned) {
    const pin = (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0)
    if (pin) return pin
  }
  return clockOf(b, clock) - clockOf(a, clock) || (a.id < b.id ? -1 : 1)
}

/**
 * The list's one order, applied: one flat band — a second ordering rule would move rows under the
 * reader.
 */
export function orderChatRows(
  rows: readonly ChatListRow[],
  clock: ChatClock = "at",
): ChatListRow[] {
  return [...rows].sort((a, b) => compareChatOrder(a, b, clock))
}

/**
 * The rows the list draws for a search: the order above, narrowed to the chats whose title or last
 * line answers the query through the matcher Code's list uses. A search narrows the list, it never
 * re-orders it — which is why it is handed the same clock the list is drawn by.
 */
export function chatList(
  rows: readonly ChatListRow[],
  query: string,
  clock: ChatClock = "at",
): ChatListRow[] {
  return filterByFuzzy(orderChatRows(rows, clock), query, (row) => [row.title, row.line])
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

/** The line a switch wears while it is offered: what turning it on does. */
const PIN_SUBTITLE = "Stays at the top of its list, on every device."

/** The line a switch wears while the list's pins have yet to be read, so nothing is counted. */
const PIN_UNKNOWN_SUBTITLE = "This list's pins are still being read."

/** The cap as the sentence names it — a line says "Five pins", not "5 pins". */
const IN_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"]

/** The line a switch wears when the list holds its cap, saying what has to happen first. */
const PIN_FULL_SUBTITLE = `${IN_WORDS[PIN_LIMIT] ?? PIN_LIMIT} pins is the most one list holds. Unpin one to make room.`

/** What the Edit sheet's Pin switch says: whether this row is pinned, whether it is drawn at all,
 * whether it may be turned, and the line under it. */
export interface PinSwitch {
  /**
   * Whether the switch belongs on the row: an archived row is drawn by the Archived pill alone, out of
   * the pinned group every list draws, so a pin on it would be a mark no list could show.
   */
  offered: boolean
  checked: boolean
  disabled: boolean
  /** What the switch does while it may be turned, or what has to happen first while it may not. */
  subtitle: string
}

/**
 * The Pin switch on one row, read against the list it is drawn in: a pinned row is always turnable —
 * unpinning is what makes room — and an unpinned one is shut once the list holds `PIN_LIMIT` pins,
 * with the line under it saying so rather than leaving a reader to guess why.
 *
 * `rows` is `undefined` until the list's own reads have answered, and a switch read against a count
 * nobody has made would offer a pin the list has no room for: it is shut, saying what it waits on.
 * The archive rule is this function's too, so every surface that draws a switch is told the same
 * thing about an archived row rather than testing the mark itself.
 */
export function pinSwitchOf(
  row: Pick<ChatRecord, "pinned" | "archived" | "main">,
  rows: readonly ChatListRow[] | undefined,
): PinSwitch {
  const checked = Boolean(row.pinned)
  // A bot's Main stands where it stands (G2): it is the bot's one permanent conversation, so no sheet
  // offers a pin it may not make. The archive rule is here for the same reason, beside it.
  if (row.main) return { offered: false, checked, disabled: true, subtitle: PIN_SUBTITLE }
  if (row.archived) return { offered: false, checked, disabled: true, subtitle: PIN_SUBTITLE }
  if (!rows) return { offered: true, checked, disabled: true, subtitle: PIN_UNKNOWN_SUBTITLE }
  const full = !checked && pinsOf(rows).length >= PIN_LIMIT
  return {
    offered: true,
    checked,
    disabled: full,
    subtitle: full ? PIN_FULL_SUBTITLE : PIN_SUBTITLE,
  }
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
 * Whether a pill is a row's at all, before it is about kinds or marks: the archive mark's one rule.
 * Archived keeps an archived row and every other pill drops one — `all` included, which is what keeps
 * an archived row out of a search over any other pill, since the pill narrows first and the search
 * narrows what it kept.
 */
export function keptBy(pill: ChatFilter, row: Pick<ChatListRow, "archived">): boolean {
  return pill === "archived" ? Boolean(row.archived) : !row.archived
}

/**
 * What each pill keeps, once the archive mark has answered for the row: Unread is the row's own dot
 * (`isUnread`, with the same mark), Chats is a row that is neither a room nor a routine's run, and a
 * room's and a run's are the row's own markers — so the three kinds partition the rows nobody
 * archived, and the pill, its dot and its sentence cannot disagree. `all` and `archived` select by
 * nothing else, which is what leaves the archive rule in `keptBy` alone.
 */
const KEEPS: Record<ChatFilter, (row: ChatListRow, marks: ReadMarks) => boolean> = {
  all: () => true,
  unread: (row, marks) => isUnread(row.at, marks[row.id]),
  archived: () => true,
  chats: (row) => !row.room && !row.routine,
  rooms: (row) => Boolean(row.room),
  routines: (row) => Boolean(row.routine),
}

/** The rows one pill keeps, in the order they were handed over. A filter never re-orders the list. */
export function filterChatRows(
  rows: readonly ChatListRow[],
  filter: ChatFilter,
  marks: ReadMarks,
): ChatListRow[] {
  return rows.filter((row) => keptBy(filter, row) && KEEPS[filter](row, marks))
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

/**
 * How old a row is, as the list says it: how long ago within the day, and the date itself beyond
 * that, since "3 days ago" is not what a reader wants off a list they scan down.
 *
 * The formatters are built once: a row asks this on every render, and a list holds fifty of them.
 */
export function chatAge(at: number, now: number) {
  if (now - at >= DAY_MS) return formatDate(at)
  const seconds = Math.round((at - now) / 1000)
  if (Math.abs(seconds) >= 3_600) return relative.format(Math.round(seconds / 3_600), "hour")
  if (Math.abs(seconds) >= 60) return relative.format(Math.round(seconds / 60), "minute")
  return relative.format(seconds, "second")
}
