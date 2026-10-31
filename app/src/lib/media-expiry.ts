/**
 * How long a URL the host signed may be drawn from. The token is minted for minutes — ten, today —
 * and a page outlives it: an app left open on a phone, or put away and come back to, still holds
 * the URL it asked for when it opened. So the mint's own `expires` is kept beside the URL, and
 * when the last of it is this close the URL is not drawn from at all: the app mints another.
 *
 * Its one import is the skew's home in `freshness.ts`, itself import-free, so
 * `scripts/test-media-expiry.mjs` still runs it as a pure rule.
 */
import { MEDIA_URL_SKEW_MS } from "./freshness.ts"

/**
 * When a URL stops being worth drawing from, in ms: where the host named no expiry — an older
 * plugin, or a copy this device holds itself — there is no such moment, and the URL is held as the
 * app always held one, repaired from its own failed load rather than from a clock.
 */
export const mediaSpentAt = (expires: number | null) =>
  expires === null ? 0 : expires * 1000 - MEDIA_URL_SKEW_MS

/** Whether a URL the host signed has run out, or is near enough that a load would outlive it. */
export const mediaSpent = (expires: number | null, now = Date.now()) =>
  expires !== null && now >= mediaSpentAt(expires)
