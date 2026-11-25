/**
 * The charm's log drained whole: every row its ring holds, oldest first, a page at a time. It holds
 * no radio — the ask is an argument, so the rule is exercised over a fake and `charm.ts` hands it
 * the one link a drain opens — which is what keeps the paging decision out of the module a test
 * cannot load.
 */
import type { CharmLogPage, CharmLogRow } from "./charm-protocol.ts"

/**
 * Pages a drain asks for before it stops trusting the charm to finish: a ring is two kilobytes of
 * twenty-six-column rows, well inside this bound, and a charm that keeps answering past it is not
 * one this page can show.
 */
const MOST_PAGES = 64

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
