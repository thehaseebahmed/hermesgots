/**
 * A host this device could not reach, said in the chat's header (ADR 0071).
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
