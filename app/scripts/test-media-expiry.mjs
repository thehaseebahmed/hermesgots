/**
 * When a URL the host signed stops being drawn from: the mint carries its own expiry, and a URL is
 * spent a minute before it, so a picture that starts loading now cannot outlive its signature. A
 * copy this device holds has no expiry to read — `0` — and is never spent.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MEDIA_URL_SKEW_MS } from "../src/lib/freshness.ts"
import { mediaSpent, mediaSpentAt } from "../src/lib/media-expiry.ts"

const at = 1_700_000_000 // Seconds, as the host reports an expiry.
const ms = at * 1000

test("a URL is spent a minute before its signature runs out, not after", () => {
  assert.equal(mediaSpent(at, ms - MEDIA_URL_SKEW_MS - 1), false, "still worth drawing from")
  assert.equal(mediaSpent(at, ms - MEDIA_URL_SKEW_MS), true, "the last minute is not trusted")
  assert.equal(mediaSpent(at, ms + 1), true, "and past the expiry it is dead")
  assert.equal(mediaSpentAt(at), ms - MEDIA_URL_SKEW_MS, "the moment it stops being drawn from")
})

test("a URL whose host named no expiry is held, and repaired from its own failed load", () => {
  assert.equal(mediaSpent(null, ms), false, "a copy this device holds never runs out")
  assert.equal(mediaSpentAt(null), 0, "and has no moment it stops")
})
