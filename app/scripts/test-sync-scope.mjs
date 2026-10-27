/**
 * The one rule a sync asks before it starts: whether a return to the app reads the account
 * documents. What a request does with the parts already running belongs to the lanes that hold
 * them, and `scripts/test-sync-scope.tsx` drives that.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ACCOUNT_SYNC_MS } from "../src/lib/freshness.ts"
import { syncsAccount } from "../src/lib/sync-scope.ts"

const ask = (trigger, lastSyncedAt, now, every = ACCOUNT_SYNC_MS) =>
  syncsAccount({ trigger, lastSyncedAt, now, every })

test("a change made here reads the account documents however recent the last read was", () => {
  assert.equal(ask("full", undefined, 10_000), true, "a first launch")
  assert.equal(ask("full", 9_999, 10_000), true, "a moment after one")
})

test("a return reads them only once they're stale", () => {
  assert.equal(ask("wake", undefined, 10_000), true, "a fresh launch reads them")
  assert.equal(ask("wake", 10_000 - ACCOUNT_SYNC_MS + 1_000, 10_000), false, "inside the window")
  assert.equal(ask("wake", 10_000 - ACCOUNT_SYNC_MS, 10_000), true, "exactly out of it")
  assert.equal(ask("wake", 10_000 - ACCOUNT_SYNC_MS - 1, 10_000), true, "a moment past it")
})

test("the window is the one freshness.ts owns, not a number of its own", () => {
  assert.equal(ask("wake", 10_000 - ACCOUNT_SYNC_MS + 1, 10_000), false)
  assert.equal(ask("wake", 10_000 - ACCOUNT_SYNC_MS + 1, 10_001, ACCOUNT_SYNC_MS - 1), true)
})
