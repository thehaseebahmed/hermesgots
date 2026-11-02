/**
 * A session's own turn state is read back from this device's transcript only when it can have
 * changed: the list's query re-runs on every write it watches, and a streaming reply writes its
 * message rows on each flush without moving any conversation row. What it read is kept bounded here,
 * so no screen has to promise to clean up after itself.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { cachedTail, forgetTail, needsTailRead, rememberTail } from "../src/lib/session-tail.ts"

const MINUTE = 60_000
const now = 1_000_000

test("a session nothing was read for is read", () => {
  assert.equal(needsTailRead(undefined, 500, now, MINUTE), true)
})

test("a session whose row moved is read again", () => {
  const tail = { rowAt: 500, readAt: now }
  assert.equal(needsTailRead(tail, 500, now, MINUTE), false)
  assert.equal(needsTailRead(tail, 600, now, MINUTE), true)
})

test("a turn that was settling is read until it settles", () => {
  const streaming = { rowAt: 500, readAt: now, turn: { streaming: true } }
  const waiting = { rowAt: 500, readAt: now, turn: { waiting: true } }
  const settled = { rowAt: 500, readAt: now, turn: {} }
  assert.equal(needsTailRead(streaming, 500, now, MINUTE), true)
  assert.equal(needsTailRead(waiting, 500, now, MINUTE), true)
  assert.equal(needsTailRead(settled, 500, now, MINUTE), false)
})

test("an old read is done again whatever the row says", () => {
  const tail = { rowAt: 500, readAt: now, turn: {} }
  assert.equal(needsTailRead(tail, 500, now + MINUTE, MINUTE), false)
  assert.equal(needsTailRead(tail, 500, now + MINUTE + 1, MINUTE), true)
  // A read that found no turn here is kept the same way, and ages out the same way.
  const none = { rowAt: 500, readAt: now }
  assert.equal(needsTailRead(none, 500, now + MINUTE, MINUTE), false)
  assert.equal(needsTailRead(none, 500, now + MINUTE + 1, MINUTE), true)
})

test("a kept tail is answered as it was read", () => {
  rememberTail("kept", { rowAt: 7, readAt: now, turn: { waiting: true } })
  assert.deepEqual(cachedTail("kept"), { rowAt: 7, readAt: now, turn: { waiting: true } })
  assert.equal(cachedTail("never-read"), undefined)
})

test("a tail read again is kept once, as the newest", () => {
  rememberTail("again", { rowAt: 1, readAt: now })
  rememberTail("again", { rowAt: 2, readAt: now + 1 })
  assert.deepEqual(cachedTail("again"), { rowAt: 2, readAt: now + 1 })
})

test("the least recently used tail goes once the store is full", () => {
  for (let i = 0; i < 520; i++) rememberTail(`bound-${i}`, { rowAt: i, readAt: now + i })
  assert.equal(cachedTail("bound-0"), undefined)
  assert.ok(cachedTail("bound-519"))
  // Read again, one becomes the newest, so it outlives the ones stored before it.
  assert.ok(cachedTail("bound-510"))
  rememberTail("bound-520", { rowAt: 0, readAt: now + 1_000 })
  assert.ok(cachedTail("bound-510"))
})

test("a forgotten tail is read again", () => {
  rememberTail("dropped", { rowAt: 9, readAt: now })
  assert.ok(cachedTail("dropped"))
  forgetTail("dropped")
  assert.equal(cachedTail("dropped"), undefined)
  assert.equal(needsTailRead(cachedTail("dropped"), 9, now, MINUTE), true)
})
