/**
 * The rules for the account's stored session tokens, as both the Android app and the browser read
 * them: what a refresh trade means, and who a stored token names.
 *
 * Its only runtime import is `./base64url.ts`, which is itself import-free, so
 * `scripts/test-identity-session.mjs` can exercise it under `node --experimental-strip-types`, the way
 * `model-changes.ts` is tested.
 */

import type { User } from "@netlify/identity"

import { fromBase64Url } from "./base64url.ts"

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
  // 403 belongs with the refusals: `bearerUser` reads Identity's 403 as "not signed in" too.
  if (status === 400 || status === 401 || status === 403) {
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

/** The account a stored access token proves: it names its owner and nothing else, which is all a
 *  client has to stand on when Identity can't be asked (docs/adr/0001). Not a proof — nothing here
 *  verifies the token, and the server vouches for every call it answers. */
export function storedUser(access: string | null): User | null {
  const claims = access ? claimsOf(access) : null
  return claims ? { id: claims.id, email: claims.email, userMetadata: {}, appMetadata: {} } : null
}

function decode(part: string) {
  return new TextDecoder().decode(fromBase64Url(part))
}
