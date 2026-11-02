/**
 * A session's own turn state — a reply streaming, one waiting on the user — as this device's
 * transcript holds it, and the rule for when an answer has to be read again.
 *
 * The read is a message scan per session, and the query it belongs to re-runs on every write it
 * watches, so without a rule the whole list re-reads every session on each streaming flush of any
 * reply. Three things make a cached answer wrong, and each is a reason to read again: the session's
 * conversation row moves when a turn starts or ends (`updatedAt`), so a row that has not moved means
 * no turn has started or ended; a question or an approval lands on a message row and moves no
 * conversation row at all, so a turn in flight has to be read while it runs; and a read old enough is
 * worth doing again whatever the row says.
 *
 * Import-free but for `src/lib/bounded-cache.ts` (the store every short-lived cache in the app uses)
 * and a `LocalTurn` type, so `scripts/test-session-tail.mjs` drives it.
 */
import { boundedStore } from "./bounded-cache.ts"
import type { LocalTurn } from "./session-work.ts"

/** A session's tail: what a read found, and the row it was read against. */
export interface SessionTail {
  /** The conversation's `updatedAt` when the tail was read. */
  rowAt: number
  /** When the read happened, on this device's clock. */
  readAt: number
  /** What the read found, if the session has a turn here at all. */
  turn?: LocalTurn
}

/**
 * How many tails are kept: above what a device lists, so a full list doesn't rotate — a cap a real
 * list sits under costs nothing, where one it exceeds makes every read evict a session still on it.
 */
const MAX_TAILS = 512

const tails = boundedStore<SessionTail>({ limit: MAX_TAILS })

/** The tail kept for this session, if one is. Reading it counts as using it. */
export const cachedTail = (id: string) => tails.get(id)

/** Keeps what a read found, dropping the least recently used once the store is full. */
export const rememberTail = (id: string, tail: SessionTail) => tails.set(id, tail)

/**
 * Drops what is kept for a session, for the one thing a tail read cannot see: a reply put back in
 * flight here (`adoptRun`) changes a message row and moves no conversation row, so the cached answer
 * would read the session as idle while its transcript streams.
 */
export const forgetTail = (id: string) => tails.forget(id)

/**
 * Whether this session's tail is worth reading now: nothing read for it yet, its row has moved since
 * the read, the turn it cached was in flight (a question or an approval is written to a message row
 * and moves no conversation row, so a wait can land with the row standing still), or the read is
 * older than `every` — which is applied the next time the list reads, since nothing here is a timer.
 */
export function needsTailRead(
  tail: SessionTail | undefined,
  updatedAt: number,
  now: number,
  every: number,
) {
  if (!tail || tail.rowAt !== updatedAt) return true
  if (now - tail.readAt > every) return true
  return Boolean(tail.turn?.streaming || tail.turn?.waiting)
}
