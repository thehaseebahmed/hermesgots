/**
 * The rows a share sheet offers: the chats and code sessions of the bot the share is going into, as a
 * rule. The screen draws exactly this (`routes/share.tsx`), so the window's edge, the order and the
 * limit are read here, with a seeded record and no DOM (AGENTS.md's unit tier).
 *
 * The sheet is a pick made while another app is still on screen, so its rows are bounded by a clock
 * rather than by a page. A row is offered while it was touched in the last seven days — the clock a
 * chat's and a session's row already draws its age from, so the list reads as what the reader has been
 * doing this week and nothing on it needs a date to make sense of. `SHARE_WINDOW_MS` is that bound.
 *
 * `SHARE_MOST` is a hard limit rather than a page size: past twenty-five rows a pick is a scroll, and
 * a sheet that keeps answering Show more is a list the reader has to page through to leave. Nothing
 * behind the limit is dropped — the sheet is not the only door to a chat — it is simply not this
 * sheet's.
 */

/** How long a row has to have been touched in to be offered: seven days, on `updatedAt`. */
export const SHARE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** The most rows the sheet ever draws: a hard limit, not a page size. */
export const SHARE_MOST = 25

/** How many rows the sheet draws before Show more, which reveals the rest of the window. */
export const SHARE_FIRST = 10

/** What a row sends into: a chat of the bot's, or a code session of one of its projects. */
export type ShareKind = "chat" | "session"

/** One row of the sheet: what it is, what it says, and the clock that placed it. */
export interface ShareTarget {
  id: string
  kind: ShareKind
  title: string
  /** When the row was last touched, which is the clock the window and the order read. */
  at: number
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
 * own screen's, a room is its own row, and a discarded session is a pile rather than a place a note
 * is sent from (ADR 0115).
 */
function kindOf(row: ShareCandidate): ShareKind | undefined {
  if (row.canvasId || row.room || row.discardedAt) return undefined
  return row.projectId ? "session" : "chat"
}

/**
 * The sheet's rows: the week's chats and code sessions, newest first with ties by id so every device
 * draws them alike, and never more than `SHARE_MOST` of them.
 */
export function recentTargets(rows: readonly ShareCandidate[], now: number): ShareTarget[] {
  const targets: ShareTarget[] = []
  for (const row of rows) {
    const kind = kindOf(row)
    if (!kind) continue
    if (now - row.updatedAt > SHARE_WINDOW_MS) continue
    targets.push({ id: row.id, kind, title: row.title, at: row.updatedAt })
  }
  return targets.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, SHARE_MOST)
}
