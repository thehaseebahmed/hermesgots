/**
 * The rows a share sheet offers: the chats, code sessions and rooms of the bot the share is going
 * into, as a rule. The screen draws exactly this (`routes/share.tsx`), so the window's edge, the
 * order, the limit and what a search keeps are read here, with a seeded record and no DOM (AGENTS.md's
 * unit tier).
 *
 * A room is no row of the bot's conversations — its record is in that read, and its row is the
 * device's room list's — so the screen hands the rooms over beside the read, and this one order
 * places them among the chats.
 *
 * The sheet is a pick made while another app is still on screen, so its rows are bounded by a clock
 * rather than by a page. A row is offered while it was touched in the last seven days — the clock a
 * chat's and a session's row already draws its age from, so the list reads as what the reader has been
 * doing this week and nothing on it needs a date to make sense of. `SHARE_WINDOW_MS` is that bound.
 *
 * `SHARE_MOST` is a hard limit rather than a page size: past twenty-five rows a pick is a scroll, and
 * a sheet that keeps answering Show more is a list the reader has to page through to leave. Nothing
 * behind the limit is dropped — the search at the foot is the way to the rest, and the sheet is not the
 * only door to a chat — it is simply not this window's.
 */
import { filterByFuzzy } from "./fuzzy.ts"

/** How long a row has to have been touched in to be offered: seven days, on `updatedAt`. */
export const SHARE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** The most rows the sheet ever draws: a hard limit, not a page size. */
export const SHARE_MOST = 25

/** How many rows the sheet draws before Show more, which reveals the rest of the window. */
export const SHARE_FIRST = 10

/** What a row sends into: a chat of the bot's, a code session of one of its projects, or a room. */
export type ShareKind = "chat" | "session" | "room"

/** The members' pictures a room's row wears, and how many it could not draw (ADR 0126). */
export interface ShareFaces {
  shown: string[]
  more: number
}

/** One row of the sheet: what it is, what it says, and the clock that placed it. */
export interface ShareTarget {
  id: string
  kind: ShareKind
  title: string
  /** When the row was last touched, which is the clock the window and the order read. */
  at: number
  /** A room's members, where a chat wears an icon: absent on every row that is not a room. */
  faces?: ShareFaces
}

/**
 * A room, as the device's own room list hands it to the sheet. A room is a conversation too, so the
 * bot's read carries its record — and the rule drops it from there, because its row is the room
 * list's and is drawn once. The fields are the record's own, whatever else it carries: the rule is
 * pure, and a room's faces are what the list read off its roster.
 */
export interface ShareRoom {
  id: string
  title: string
  updatedAt: number
  faces: ShareFaces
}

/**
 * The fields of a conversation this rule reads. Spelled out here rather than imported, because the
 * rule is pure: a record is a row of the bot's list, whatever else its schema carries.
 */
export interface ShareCandidate {
  id: string
  title: string
  updatedAt: number
  /** A code session of this project; absent for a plain chat. */
  projectId?: string
  /** A canvas's own chat, which is its screen's and never a list's. */
  canvasId?: string
  /** A room, whose row is its own and whose words are the Host's. */
  room?: unknown
  /** A session in the project's discarded pile. */
  discardedAt?: number
}

/**
 * What a conversation is to the sheet, or nothing where the sheet doesn't offer it: a canvas is its
 * own screen's, a room is the room list's row rather than this read's, and a discarded session is a
 * pile rather than a place a note is sent from (ADR 0115).
 */
function kindOf(row: ShareCandidate): ShareKind | undefined {
  if (row.canvasId || row.room || row.discardedAt) return undefined
  return row.projectId ? "session" : "chat"
}

/**
 * Every row the sheet can reach, in the one order it draws them: newest first with ties by id so every
 * device draws them alike. The window and the search take this same list, so a row's place among the
 * others is decided once however it was found — a room's included, since its clock is the record's
 * own as a chat's is.
 */
function orderedTargets(
  rows: readonly ShareCandidate[],
  rooms: readonly ShareRoom[],
): ShareTarget[] {
  const targets: ShareTarget[] = []
  for (const row of rows) {
    const kind = kindOf(row)
    if (!kind) continue
    targets.push({ id: row.id, kind, title: row.title, at: row.updatedAt })
  }
  for (const room of rooms)
    targets.push({
      id: room.id,
      kind: "room",
      title: room.title,
      at: room.updatedAt,
      faces: room.faces,
    })
  return targets.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
}

/**
 * The window: the week's chats, code sessions and rooms, newest first, and never more than
 * `SHARE_MOST` of them. `rooms` are the ones the picked bot's roster seats, which the device's room
 * list holds rather than the bot's read.
 */
export function recentTargets(
  rows: readonly ShareCandidate[],
  now: number,
  rooms: readonly ShareRoom[] = [],
): ShareTarget[] {
  return orderedTargets(rows, rooms)
    .filter((target) => now - target.at <= SHARE_WINDOW_MS)
    .slice(0, SHARE_MOST)
}

/**
 * The rows a query keeps: every one of the bot's whose title answers it through the matcher the app's
 * lists already use, best match first and the list's own order inside a rank — a search narrows the
 * sheet, it never re-orders it. Every match is drawn, in full: the seven days and the twenty-five are
 * the window the field leads out of, not its edge, since a search that refused a row the sheet had
 * just shown would be a trap.
 *
 * An empty query answers nothing: the screen asks this only while there is something to search by,
 * and a blank field draws the window again.
 */
export function searchTargets(
  rows: readonly ShareCandidate[],
  query: string,
  rooms: readonly ShareRoom[] = [],
): ShareTarget[] {
  if (!query.trim()) return []
  return filterByFuzzy(orderedTargets(rows, rooms), query, (row) => [row.title])
}
