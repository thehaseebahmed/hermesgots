import assert from "node:assert/strict"
import { test } from "node:test"

import { markerText, markersOf, spanWords } from "../src/lib/routine-marker.ts"

test("a run's length is said in minutes and seconds", () => {
  assert.equal(spanWords(125_000), "2 min 5 secs")
  assert.equal(spanWords(42_000), "42 secs")
  assert.equal(spanWords(61_000), "1 min 1 sec")
  assert.equal(spanWords(120_000), "2 min")
  assert.equal(spanWords(4_400_000), "73 min 20 secs")
  assert.equal(spanWords(0), "0 secs")
})

test("a marker names the routine and how long it ran", () => {
  assert.equal(markerText("Daily standup", 125_000), 'Routine "Daily standup" ran for 2 min 5 secs')
})

test("a run with no duration says only that it ran", () => {
  assert.equal(markerText("Daily standup"), 'Routine "Daily standup" ran')
  assert.equal(markerText("  "), 'Routine "Routine" ran')
})

test("markers are the routine records alone, oldest first", () => {
  const found = markersOf([
    { id: "b", title: "B", updatedAt: 20, routine: true, durationMs: 1000 },
    { id: "chat", title: "Chat", updatedAt: 5 },
    { id: "a", title: "A", updatedAt: 10, routine: true },
  ])
  assert.deepEqual(
    found.map((marker) => [marker.id, marker.at]),
    [
      ["a", 10],
      ["b", 20],
    ],
  )
})
