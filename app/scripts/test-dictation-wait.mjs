import assert from "node:assert/strict"
import test from "node:test"

import {
  WAIT_PART_LABELS,
  WAIT_PARTS,
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
  waitInserted("take-0", 1000)
  assert.equal(lastWait(), null, "words with no Stop under way close nothing")
})

test("a take's wait runs from the Stop to the words, in four parts", () => {
  waitStarts("take-1", 1000)
  waitReaches("take-1", "closed", 1420)
  waitReaches("take-1", "uploaded", 1430)
  waitReaches("take-1", "answered", 1836)
  waitInserted("take-1", 1840)
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

test("the take that owns the wait is the only one that marks, closes or drops it", () => {
  waitStarts("old", 0)
  waitStarts("new", 100)
  waitReaches("old", "closed", 900)
  waitInserted("old", 1000)
  waitDrops("old")
  const wait = lastWait()
  assert.equal(wait.take, "new", "the newer take still owns the wait")
  assert.equal(wait.closed, undefined, "the old take's mark is not the new take's")
  assert.equal(wait.inserted, undefined, "and neither are its words")
})

test("a retry, which presses no Stop, closes no wait", () => {
  waitStarts("first", 0)
  waitReaches("first", "closed", 10)
  waitReaches("first", "uploaded", 20)
  waitReaches("first", "answered", 30)
  waitInserted("first", 40)
  waitDrops("first")
  waitReaches("second", "closed", 100)
  waitReaches("second", "answered", 200)
  waitInserted("second", 300)
  assert.equal(lastWait(), null, "the retry's words closed a wait no Stop opened")
})

test("a take still under way spans only what it has reached", () => {
  waitStarts("running", 100)
  waitReaches("running", "closed", 200)
  const wait = lastWait()
  assert.deepEqual(waitSpans(wait), [{ part: "closed", ms: 100 }])
  assert.equal(waitTotal(wait), null, "and it is not a Stop to text yet")
})

test("a total is never printed from a wait with a part missing", () => {
  waitStarts("gappy", 100)
  waitReaches("gappy", "closed", 200)
  waitInserted("gappy", 300)
  const wait = lastWait()
  assert.deepEqual(waitSpans(wait), [{ part: "closed", ms: 100 }], "the walk stops at the gap")
  assert.equal(waitTotal(wait), null, "and the whole is withheld rather than read across it")
})

test("every part has the words it is printed as, and no label is left over", () => {
  assert.deepEqual(Object.keys(WAIT_PART_LABELS).sort(), [...WAIT_PARTS].sort())
})
