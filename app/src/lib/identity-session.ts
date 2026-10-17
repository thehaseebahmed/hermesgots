/**
 * The rules for the account session's stored tokens, on the Android app's own Identity calls.
 *
 * Free of runtime imports so `scripts/test-identity-session.mjs` can exercise it under
 * `node --experimental-strip-types`, the way `model-changes.ts` is tested.
 */

export interface Tokens {
  access: string
  refresh: string
  /** Unix ms. */
  expiresAt: number
}

export type TradeOutcome =
  /** Identity traded the token: the answer carries a fresh pair. */
  | "renewed"
  /** Another caller spent this token first: the store already holds the pair it got back. */
  | "swapped"
  /** Identity declined this token and the store still holds it: the session is over. */
  | "ended"
  /** No verdict about the token (an unwell or rate-limited service): the session stands. */
  | "retry"

/**
 * How one refresh trade is read. Identity revokes a refresh token as it spends it, so a token it
 * declines is usually one another caller already traded; the store is the source of truth, and
 * only a token the service declined *and* that is still the stored one ends the session.
 */
export function tradeOutcome(
  status: number,
  spentRefresh: string,
  storedRefresh: string | null,
): TradeOutcome {
  if (status === 200) return "renewed"
  if (status >= 500 || status === 429) return "retry"
  if (status === 400 || status === 401) {
    return storedRefresh && storedRefresh !== spentRefresh ? "swapped" : "ended"
  }
  return "retry"
}

/** Who a stored access token names, from its own claims: what a device proves with no service. */
export function claimsOf(access: string): { id: string; email?: string } | null {
  const part = access.split(".")[1]
  if (!part) return null
  try {
    const claims = JSON.parse(decode(part)) as { sub?: unknown; email?: unknown }
    if (typeof claims.sub !== "string" || !claims.sub) return null
    return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined }
  } catch {
    return null
  }
}

function decode(part: string) {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}
