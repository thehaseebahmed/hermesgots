/**
 * A host this device could not reach, said in the chat's header (ADR 0071), and what the page reads
 * at while it is away (ADR 0082).
 *
 * The app cannot tell a dead host from a dead device: both arrive as a fetch that failed or timed
 * out. `navigator.onLine` is the only fact that separates them, so the sentence is chosen here from
 * the state and the device's own answer, and drawn by whatever shows the chat's header.
 */

export const AWAY_SEND_MS = 4_000

/**
 * What the chat's header says while the host cannot be reached, in place of the line it usually
 * carries; nothing while it can. A device with no network at all is told so, since waiting on the
 * host would be waiting on the wrong thing.
 */
export function awayLine(away: boolean, online: boolean): string | undefined {
  if (!away) return undefined
  return online ? "This host isn't answering" : "You're offline"
}

export function sendTimeoutMs(away: boolean, readMs: number): number {
  return away ? Math.min(AWAY_SEND_MS, readMs) : readMs
}

/** What the page is doing, as far as how often it reads depends on it. */
export interface PaceState {
  /** Something is under way, so the page reads at the fast pace. */
  busy: boolean
  /** Reads in a row that got no answer: none while the host answers, and the header's words since. */
  misses: number
  /** The bot's server is streaming this page's changes, so the timer is the net under the stream. */
  streamOpen: boolean
}

/** The paces the page keeps: the fast one, its idle one, and the net an open stream leaves it. */
export interface Paces {
  pollMs: number
  idleMs: number
  safetyMs: number
}

/**
 * How long the page may go before reading again. A read that lands is the only thing that takes the
 * away words back, so a host that has just missed a read is read as fast as a busy page is — behind
 * an open stream the net can be five minutes away, and the words would outlive the host that
 * answered them. It slows to `idleMs` as the host keeps not answering, so a host that is really
 * gone is read at the pace the page keeps anyway.
 */
export function readPace({ busy, misses, streamOpen }: PaceState, paces: Paces): number {
  const { pollMs, idleMs, safetyMs } = paces
  if (misses > 0) return Math.min(pollMs * 2 ** (misses - 1), idleMs)
  if (busy) return pollMs
  return streamOpen ? Math.max(idleMs, safetyMs) : idleMs
}
