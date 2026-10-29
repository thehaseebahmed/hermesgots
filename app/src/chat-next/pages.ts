import type { Row, Turn } from "./fold.ts"

/** How many rows a page of the host's transcript holds. */
export const PAGE = 50

/** A page that comes back short is the first one the host has: nothing is older. */
export const isLast = (page: Row[]) => page.length < PAGE

/** The rows with a row that came twice kept at its first place, as pages that slide leave them. */
export function uniq(rows: Row[]): Row[] {
  const seen = new Set<number>()
  return rows.filter((row) => !seen.has(row.id) && seen.add(row.id))
}

/**
 * Where a page joins the held rows: the index of the held row it starts at, when its rows are the
 * held ones from there on and in the same order; -1 when it does not (nothing held, a compaction or
 * an undo changed the newest rows, or a page of rows written since shares none of the held ones).
 */
export function joinAt(held: Row[] | undefined, page: Row[]): number {
  const at = held?.findIndex((row) => row.id === page[0]?.id) ?? -1
  // A page that runs past the held rows' end (rows written since) joins on the rows it shares.
  return !held || at < 0 || !page.every((row, i) => !held[at + i] || held[at + i].id === row.id)
    ? -1
    : at
}

/**
 * Where a read of the newest rows stands once it has the pages so far (`pages`, the oldest rows
 * first, so `pages[0]` is the page just read): `undefined` when the next older page is to be read,
 * else the rows to draw and whether older ones are still unread (`more`).
 *
 * - A short page is the start of the chat: everything is read.
 * - A page that joins the rows held ends the read: what is older is trusted as held, and whether
 *   anything of it is unread stays as the device knew it (`more` undefined). The rows are then only
 *   the ones read, to be laid over the held rows where they join (`overlay`): the held rows may have
 *   changed since the read began, as an older page lands above them.
 * - With nothing held there is nothing to join, so the first page is drawn at once and the older ones
 *   follow (`more`).
 * - With rows held the read goes on until a page joins them, since the held rows are drawn
 *   meanwhile and a thread that fell more than a page behind is caught up in one step.
 */
export function newestRead(
  pages: Row[][],
  held?: Row[],
): { rows: Row[]; more: boolean | undefined; joined: boolean } | undefined {
  const page = pages[0]
  if (!page) return undefined
  const rows = uniq(pages.flat())
  if (isLast(page)) return { rows, more: false, joined: false }
  const at = joinAt(held, page)
  // Rows written while the pages were read slide into the next offset, so a page that joins the
  // held rows only counts when it also reaches back to the held row it starts at.
  if (at >= 0) return { rows, more: undefined, joined: true }
  if (!held?.length) return { rows, more: true, joined: false }
  return undefined
}

/**
 * The rows `held` now holds with the rows `read` laid over them from the row they start at, which is
 * how a read that joined lands; undefined where the held rows no longer have that row, since they
 * were replaced after the read began and the read is no longer what they continue.
 */
export function overlay(held: Row[], read: Row[]): Row[] | undefined {
  const at = held.findIndex((row) => row.id === read[0]?.id)
  return at < 0 ? undefined : [...held.slice(0, at), ...read]
}

/** The offset of the next older page: the host counts from its newest row, and the rows held are its newest. */
export const nextOffset = (rows: Row[]) => rows.length

/** The rows with an older page put above them; a row the page shares with them stays where they have it. */
export function prepend(rows: Row[], older: Row[]): Row[] {
  const held = new Set(rows.map((row) => row.id))
  const above = older.filter((row) => !held.has(row.id))
  return above.length ? [...above, ...rows] : rows
}

/**
 * How many places the turns `next` hold sit further down than the turns `prev` did, found by the
 * first turn of `prev` that has a row of its own and is in `next` still; undefined where no turn
 * says. Turns added above make it positive; turns added below leave it 0.
 */
export function shift(prev: Turn[], next: Turn[]): number | undefined {
  const rowAt = new Map<number, number>()
  next.forEach((turn, at) => turn.row !== undefined && rowAt.set(turn.row, at))
  for (let from = 0; from < prev.length; from++) {
    const row = prev[from].row
    const to = row === undefined ? undefined : rowAt.get(row)
    if (to !== undefined) return to - from
  }
  return undefined
}

/**
 * The place the first of `next` holds in a thread whose turns were `prev` (counted from `prev.origin`),
 * such that a turn keeps its place when older turns are added above it. With no turn in common the
 * count goes on from where it was.
 */
export function originOf(prev: { turns: Turn[]; origin: number }, next: Turn[]): number {
  const moved = shift(prev.turns, next)
  return moved === undefined ? prev.origin : prev.origin - moved
}
