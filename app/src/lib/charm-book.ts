/**
 * The charm's log kept as a book, from one read to the next: the rows a reader has already taken,
 * each at the index the charm numbered it with, folded back into the lines the panel wrapped. Pure —
 * no radio, no store and no React — so `scripts/test-charm-book.mjs` drives every rule of it without
 * a device, and the Debug Charm page (`components/charm-debug.tsx`) reads nothing else.
 */
import type { CharmLogRow, CharmLogSincePage } from "./charm-protocol.ts"

/**
 * How many lines the book keeps: a few minutes at the rate the charm prints, and a list a phone can
 * redraw every two seconds. Lines rather than rows, since a wrapped line is one line to a reader.
 */
export const KEPT = 1000

/** A row the book holds: the charm's row, and the index the charm numbered it with. */
export interface CharmBookRow extends CharmLogRow {
  index: number
}

/**
 * The book itself: the rows taken so far in the order they were read, and `next` — the index the next
 * ask starts from, which is the last row held rather than the one after it, because the charm's newest
 * row is usually still being printed and grows between reads.
 */
export interface CharmBook {
  rows: CharmBookRow[]
  next: number
}

/**
 * Whether a row carries on the line before it: the panel's own flag says this row is the remainder of
 * a wrapped line, and the indices say the two were printed side by side. A row after a hole in the ring
 * must not finish the line the hole cut, or the book would read as one line the charm never printed.
 */
function continues(row: CharmBookRow, before: CharmBookRow | undefined) {
  return before !== undefined && row.carried && row.index === before.index + 1
}

/**
 * Where the book's current run begins. A charm that reboots starts its count again, and the book keeps
 * the lines it read before that — so the rows are two runs, and the new one begins where the counts
 * step backwards. A run whose first page has not landed yet holds no rows of its own, and is the one
 * case with no step to find: the book asking from behind its own newest row is that state.
 */
function runStart(book: CharmBook) {
  for (let at = book.rows.length - 1; at > 0; at--) {
    if (book.rows[at].index <= book.rows[at - 1].index) return at
  }
  const newest = book.rows[book.rows.length - 1]
  return newest !== undefined && book.next < newest.index ? book.rows.length : 0
}

/**
 * The book cut back to its newest `KEPT` lines. The rows of a trimmed line go with it, so the oldest
 * line the book still holds is whole and reads as the charm printed it, rather than as the tail of a
 * line that is no longer there.
 */
function trim(rows: CharmBookRow[]): CharmBookRow[] {
  let kept = 1
  for (let at = rows.length - 1; at > 0; at--) {
    if (continues(rows[at], rows[at - 1])) continue
    if (kept === KEPT) return rows.slice(at)
    kept++
  }
  return rows
}

/**
 * Whether the page says the charm's count began again: it answered nothing, and from an index behind
 * the one the book asked with. A ring past its newest row answers from beyond the ask instead, which
 * is why the second half is needed before this can be read as a boot.
 */
function restarted(book: CharmBook, page: CharmLogSincePage) {
  return page.rows.length === 0 && page.base < book.next
}

/**
 * Where the next ask starts after this page. A page with rows leaves its last one, which is asked for
 * again so it can grow; a page with none leaves `next` where it was, unless its base is behind the book
 * — the charm's count began again, and asking from the old count would wait for an index it never
 * reaches.
 */
function nextAfter(book: CharmBook, page: CharmLogSincePage) {
  if (page.rows.length) return page.base + page.rows.length - 1
  return restarted(book, page) ? page.base : book.next
}

/**
 * The book with a page the charm answered placed into it. The rows at or past the page's base are
 * replaced by the page's own — a contiguous run from that base, which is how the row the charm is still
 * printing grows where it stands instead of being held twice — and the rows before it stay, since they
 * are lines the reader has already been shown. A page whose base is past `next` leaves the rows between
 * them out: the ring dropped them, and the book marks no hole for rows it never read. A page that says
 * the charm rebooted replaces nothing, because the lines before the boot are still the reader's.
 */
export function place(book: CharmBook, page: CharmLogSincePage): CharmBook {
  const start = restarted(book, page) ? book.rows.length : runStart(book)
  const rows = book.rows.filter((row, at) => at < start || row.index < page.base)
  page.rows.forEach((row, at) => {
    rows.push({ index: page.base + at, text: row.text, carried: row.carried })
  })
  return { rows: trim(rows), next: nextAfter(book, page) }
}

/**
 * The book as whole lines, oldest first, which is what a reader is shown and what a copy carries. A
 * book whose first row is the remainder of a line the cap trimmed away starts a line of its own with
 * it, since there is no earlier row here to finish.
 */
export function lines(book: CharmBook): string[] {
  const drawn: string[] = []
  book.rows.forEach((row, at) => {
    if (continues(row, book.rows[at - 1])) drawn[drawn.length - 1] += row.text
    else drawn.push(row.text)
  })
  return drawn
}

/** The whole book as one block a copy hands over: a line per line, oldest first, nothing added. */
export function text(book: CharmBook) {
  return lines(book).join("\n")
}
