import assert from "node:assert/strict"
import test from "node:test"

import {
  lastWait,
  waitDrops,
  waitInserted,
  waitReaches,
  waitSpans,
  waitStarts,
  waitTotal,
} from "../src/lib/dictation-wait.ts"

test("no take has a wait until its Stop is pressed", () => {
  assert.equal(lastWait(), null)
  waitInserted(1000)
  assert.equal(lastWait(), null, "words with no Stop under way close nothing")
})

test("a take's wait runs from the Stop to the words, in four parts", () => {
  waitStarts("take-1", 1000)
  waitReaches("take-1", "closed", 1420)
  waitReaches("take-1", "uploaded", 1430)
  waitReaches("take-1", "answered", 1836)
  waitInserted(1840)
  const wait = lastWait()
  assert.deepEqual(
    waitSpans(wait).map(({ part, ms }) => [part, ms]),
    [
      ["closed", 420],
      ["uploaded", 10],
      ["answered", 406],
      ["inserted", 4],
    ],
  )
  assert.equal(waitTotal(wait), 840, "and the whole of it is the Stop to the words")
})

test("a part is recorded once, so a late mark cannot stretch it", () => {
  waitStarts("take-2", 500)
  waitReaches("take-2", "closed", 900)
  waitReaches("take-2", "closed", 5000)
  assert.deepEqual(waitSpans(lastWait()), [{ part: "closed", ms: 400 }])
})

test("an ending a newer take replaced writes nothing into the new one", () => {
  waitStarts("old", 0)
  waitStarts("new", 100)
  waitReaches("old", "closed", 900)
  assert.deepEqual(waitSpans(lastWait()), [], "the old take's mark is not the new take's")
})

test("a retry, which presses no Stop, closes no wait", () => {
  waitStarts("first", 0)
  waitReaches("first", "closed", 10)
  waitReaches("first", "uploaded", 20)
  waitReaches("first", "answered", 30)
  waitInserted(40)
  // The take is sent again under a fresh Take id: its wait is dropped, and the words that land are
  // the retry's, not a Stop to text.
  waitDrops()
  waitReaches("second", "closed", 100)
  waitReaches("second", "answered", 200)
  waitInserted(300)
  assert.equal(lastWait(), null, "the retry's words closed a wait no Stop opened")
})

test("a take that died before a part spans only what it reached", () => {
  waitStarts("died", 100)
  waitReaches("died", "closed", 200)
  const wait = lastWait()
  assert.deepEqual(waitSpans(wait), [{ part: "closed", ms: 100 }])
  assert.equal(waitTotal(wait), null, "and it is not a Stop to text yet")
})

test("a clock that stepped back holds a part at zero, never a negative wait", () => {
  waitStarts("stepped", 1000)
  waitReaches("stepped", "closed", 900)
  assert.deepEqual(waitSpans(lastWait()), [{ part: "closed", ms: 0 }])
})
