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
import type { Conversation } from "./db.ts"
import { filterByFuzzy } from "./fuzzy.ts"

export const SHARE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export const SHARE_MOST = 25

export const SHARE_FIRST = 10

/** What a row sends into: a chat of the bot's, a code session of one of its projects, or a room. */
export type ShareKind = "chat" | "session" | "room"

export interface ShareFaces {
  shown: string[]
  more: number
}

/**
 * One row of the sheet: what it is, what it says, and the clock that placed it. A room is the one kind
 * that wears something a chat doesn't — its members' faces, where a chat wears its disc — so the type
 * carries them only on a room, and no reader has to hedge with a fallback.
 */
export type ShareTarget =
  | {
      id: string
      kind: "chat" | "session"
      title: string
      at: number
    }
  | {
      id: string
      kind: "room"
      title: string
      at: number
      faces: ShareFaces
    }

export interface ShareRoom {
  id: string
  title: string
  updatedAt: number
  faces: ShareFaces
}

/**
 * The fields of a conversation this rule reads: a row of the bot's list, and only the parts of it the
 * sheet places. Read off the schema rather than spelled out again, so a field the record moves is a
 * compile error here instead of a row that quietly stops being offered. A type-only import, so nothing
 * of the database is loaded and `scripts/test-share-list.mjs` still runs the rule as a pure one.
 */
export type ShareCandidate = Pick<
  Conversation,
  "id" | "title" | "updatedAt" | "projectId" | "canvasId" | "room" | "discardedAt"
>

/**
 * What a row sends into, and nothing where the sheet has no place to send it: a canvas's chat is its
 * own screen's and lists nowhere (ADR 0113), a room's record is the room list's and is drawn once
 * from there (ADR 0115), and a session the reader has thrown away is not a place a note is sent from.
 */
function kindOf(row: ShareCandidate): "chat" | "session" | undefined {
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
 *
 * The week is taken off the read before the order is built, so the rows the sheet could never draw are
 * neither mapped nor sorted — a bot's whole history arrives here, and only its week is a row.
 */
export function recentTargets(
  rows: readonly ShareCandidate[],
  now: number,
  rooms: readonly ShareRoom[] = [],
): ShareTarget[] {
  const since = now - SHARE_WINDOW_MS
  return orderedTargets(
    rows.filter((row) => row.updatedAt >= since),
    rooms.filter((room) => room.updatedAt >= since),
  ).slice(0, SHARE_MOST)
}

/**
 * Whether a query holds anything the matcher can search by. `filterByFuzzy` reads a query's words as
 * letters and digits alone, so a query of punctuation — or of a script it keeps no letters of — has
 * no words at all, and the matcher answers it with every row it was handed. That is a bot's whole
 * history in the window's place, and no further keystroke can narrow it, so the field answers
 * nothing for it instead. The alphabet is the matcher's own (`plain` in `fuzzy.ts`).
 */
const searchable = (query: string) => /[a-z0-9]/i.test(query)

/**
 * The rows a query keeps: every one of the bot's whose title answers it through the matcher the app's
 * lists already use. Every match is drawn, in full: the seven days and the twenty-five are the window
 * the field leads out of, not its edge, since a search that refused a row the sheet had just shown
 * would be a trap.
 *
 * A query with nothing to search by answers nothing: the screen asks this only while there is
 * something to search by, a blank field draws the window again, and a field of punctuation is the
 * whole history where the window was — so it is no query either.
 */
export function searchTargets(
  rows: readonly ShareCandidate[],
  query: string,
  rooms: readonly ShareRoom[] = [],
): ShareTarget[] {
  if (!searchable(query)) return []
  return filterByFuzzy(orderedTargets(rows, rooms), query, (row) => [row.title])
}
