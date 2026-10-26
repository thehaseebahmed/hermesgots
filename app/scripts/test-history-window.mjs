import assert from "node:assert/strict"
import test from "node:test"

import { mayHoldArchive, nextWindow } from "../src/lib/history-window.ts"

const live = (id, offset) => ({ id, offset })
const archived = (id) => ({ id, offset: 0, archived: true })
const step = (over) => ({ end: false, offset: 0, ...over })

test("a step with history still above it keeps the numbering it walks", () => {
  const next = nextWindow(live(900, 100), step({ oldest: 800, offset: 150 }), true)
  assert.deepEqual(next, { cursor: live(800, 150), more: true })
})

test("the live transcript running out hands over to the display read", () => {
  const next = nextWindow(live(500, 300), step({ oldest: 400, end: true, offset: 350 }), true)
  assert.deepEqual(next, { cursor: archived(400), more: true })
})

test("the display read starts its numbering again, since the row id is the edge", () => {
  const next = nextWindow(live(500, 300), step({ end: true, offset: 350 }), true)
  assert.deepEqual(next, { cursor: archived(500), more: true })
})

test("an empty compactions list is the host saying the chat was never compacted", () => {
  assert.equal(mayHoldArchive([]), false)
  const next = nextWindow(live(500, 300), step({ oldest: 400, end: true, offset: 350 }), false)
  assert.deepEqual(next, { more: false })
})

test("a list nobody has read is a question still open, not an archive", () => {
  // Only the host's own list sends a reach into the archive: a list nobody has read says nothing,
  // and reading a display order to find out would answer every row the device already holds.
  assert.equal(mayHoldArchive(undefined), false)
  const next = nextWindow(live(500, 300), step({ oldest: 400, end: true, offset: 350 }), false)
  assert.deepEqual(next, { more: false })
})

test("a list with a compaction in it is the host saying there are archived rows", () => {
  assert.equal(mayHoldArchive([{ at: 1, tokens: 2 }]), true)
})

test("the display read running out means the chat's first row is in", () => {
  const next = nextWindow(archived(120), step({ oldest: 60, end: true, offset: 500 }), true)
  assert.deepEqual(next, { more: false })
})

test("rows the trim used to drop are kept: a page that runs short is the end of the chat", () => {
  const next = nextWindow(live(900, 100), step({ oldest: 800, end: true }), false)
  assert.deepEqual(next, { more: false })
})

test("the offset a step stopped at is where the next one reads", () => {
  const next = nextWindow(live(900, 100), step({ oldest: 700, offset: 400 }), true)
  assert.equal(next.cursor.offset, 400)
})

test("an archived step that runs out never switches back to the live numbering", () => {
  const next = nextWindow(archived(20), step({ oldest: 10, end: true, offset: 900 }), true)
  assert.equal(next.more, false)
})
