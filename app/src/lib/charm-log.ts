/**
 * The charm's log drained whole: every row its ring holds, oldest first, a page at a time. It holds
 * no radio — the ask is an argument, so the rule is exercised over a fake and `charm.ts` hands it
 * the one link a drain opens — which is what keeps the paging decision out of the module a test
 * cannot load.
 */
import type { CharmLogPage, CharmLogRow, CharmLogSincePage } from "./charm-protocol.ts"

/**
 * Pages one drain asks for before it stops trusting the charm to finish: a ring is two kilobytes of
 * twenty-six-column rows, well inside this bound, and a charm that keeps answering past it is not
 * one this page can show. Both drains share it — the tail's and the book's.
 */
export const MOST_PAGES = 64

/**
 * A whole ring, oldest first, over however many pages the charm answers with. The next ask counts
 * from the page's own base rather than from the count asked for, because a ring that dropped the
 * rows wanted answers from its oldest instead; a page with no rows, a page that reached the charm's
 * total and the `MOST_PAGES`th page each end the drain.
 */
export async function drain(ask: (from: number) => Promise<CharmLogPage>): Promise<CharmLogRow[]> {
  const rows: CharmLogRow[] = []
  let from = 0
  for (let page = 0; page < MOST_PAGES; page++) {
    const answered = await ask(from)
    rows.push(...answered.rows)
    from = answered.from + answered.rows.length
    if (answered.rows.length === 0 || from >= answered.total) break
  }
  return rows
}

/**
 * The pages a book's read takes, from the row it already holds: each asked for from the page's own
 * last row, that row again so a line the charm is still printing grows rather than freezing at its
 * first twenty-six columns. Asking for that row means a caught-up charm answers it and nothing more,
 * so a page carrying nothing after the row asked for is the end — an empty page alone would never
 * arrive, and the drain would spend its whole budget re-reading one row every poll. Null is a charm
 * whose firmware predates the op, which answers `BadMessage` to the first ask and keeps no book.
 */
export async function drainSince(
  ask: (from: number) => Promise<CharmLogSincePage | null>,
  from: number,
): Promise<CharmLogSincePage[] | null> {
  const pages: CharmLogSincePage[] = []
  let at = from
  for (let page = 0; page < MOST_PAGES; page++) {
    const answered = await ask(at)
    if (!answered) return null
    pages.push(answered)
    const last = answered.base + answered.rows.length - 1
    if (answered.rows.length === 0 || last <= at) break
    at = last
  }
  return pages
}
