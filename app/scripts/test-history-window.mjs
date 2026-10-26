import assert from "node:assert/strict"
import test from "node:test"

import { mayHoldArchive, nextWindow, windowKey } from "../src/lib/history-window.ts"

const live = (id, offset) => ({ kind: "live", id, offset })
const archived = (id) => ({ kind: "archive", id })
const step = (over) => ({ end: false, offset: 0, ...over })

test("a step with history still above it keeps the numbering it walks", () => {
  assert.deepEqual(nextWindow(live(900, 100), step({ oldest: 800, offset: 150 }), true), live(800, 150))
})

test("the live transcript running out hands over to the display read", () => {
  assert.deepEqual(nextWindow(live(500, 300), step({ oldest: 400, end: true, offset: 350 }), true), archived(400))
})

test("the display read starts its numbering again, since the row id is the edge", () => {
  assert.deepEqual(nextWindow(live(500, 300), step({ end: true, offset: 350 }), true), archived(500))
})

test("an empty compactions list is the host saying the chat was never compacted", () => {
  assert.equal(mayHoldArchive([]), false)
  assert.equal(nextWindow(live(500, 300), step({ oldest: 400, end: true, offset: 350 }), false), undefined)
})

test("a list nobody has read is a question still open, not an archive", () => {
  assert.equal(mayHoldArchive(undefined), false)
  assert.equal(nextWindow(live(500, 300), step({ oldest: 400, end: true, offset: 350 }), false), undefined)
})

test("a list with a compaction in it is the host saying there are archived rows", () => {
  assert.equal(mayHoldArchive([{ at: 1, tokens: 2 }]), true)
})

test("the display read running out means the chat's first row is in", () => {
  assert.equal(nextWindow(archived(120), step({ oldest: 60, end: true, offset: 500 }), true), undefined)
})

test("a page that runs short is the end of the chat", () => {
  assert.equal(nextWindow(live(900, 100), step({ oldest: 800, end: true }), false), undefined)
})

test("the offset a step stopped at is where the next one reads", () => {
  assert.equal(nextWindow(live(900, 100), step({ oldest: 700, offset: 400 }), true).offset, 400)
})

test("a step that kept only rows already held does not clear the cursor", () => {
  // A page of rows the device holds says nothing about where the chat starts: the numbering moves
  // on and the edge stays, so a page of carried copies can't truncate the archive.
  assert.deepEqual(nextWindow(live(700, 500), step({ offset: 1000 }), true), live(700, 1000))
  assert.deepEqual(nextWindow(archived(700), step({ offset: 1000 }), true), archived(700))
})

test("a window with no edge left is not the same as one that never had rows", () => {
  assert.deepEqual(nextWindow(live(700, 500), step({ end: true }), true), archived(700))
})

test("the key the screen watches moves with whichever numbering moved", () => {
  assert.equal(windowKey(live(9, 40)), "9:40")
  assert.equal(windowKey(archived(9)), "9:archive")
  assert.notEqual(windowKey(live(9, 40)), windowKey(archived(9)))
})
