import assert from "node:assert/strict"
import test from "node:test"

import {
  agrees,
  byMonth,
  clearedAway,
  countWords,
  fingerprintOf,
  monthKey,
  monthLabel,
  pooledRate,
  spokenOf,
  sumTotals,
  toUpsert,
} from "../src/lib/dictation-log.ts"

const LOCAL = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime()

test("a take's words are counted on whitespace", () => {
  assert.equal(countWords(""), 0)
  assert.equal(countWords("   "), 0)
  assert.equal(countWords(" one  two\nthree "), 3)
  assert.equal(countWords("a hyphenated-word is one"), 4)
})

test("a take's spoken span is its pieces, pauses left out", () => {
  assert.equal(spokenOf([]), 0)
  assert.equal(spokenOf([1200, 800]), 2000)
  assert.equal(spokenOf([1200, -400]), 1200, "a span that isn't one can't take away from the total")
})

test("a dictation's month is the key two of them are grouped under", () => {
  const early = LOCAL(2026, 10, 2, 9)
  const late = LOCAL(2026, 10, 28, 22)
  assert.equal(monthKey(early), "2026-10")
  assert.equal(monthKey(late), "2026-10", "the same month keeps one key whatever the day")
  assert.equal(monthKey(LOCAL(2026, 9, 30)), "2026-09")
  assert.equal(monthKey(LOCAL(2027, 1, 1)), "2027-01", "January pads its month")
  assert.match(monthLabel(early), /2026/)
})

test("dictations group under their month, in the order they arrived", () => {
  const groups = byMonth([
    { id: "a", at: LOCAL(2026, 10, 20) },
    { id: "b", at: LOCAL(2026, 10, 3) },
    { id: "c", at: LOCAL(2026, 9, 28) },
  ])
  assert.deepEqual(
    groups.map((group) => [group.key, group.rows.map((row) => row.id)]),
    [
      ["2026-10", ["a", "b"]],
      ["2026-09", ["c"]],
    ],
  )
  assert.equal(groups[0].label, monthLabel(LOCAL(2026, 10, 20)))
})

test("a fingerprint is a count and its two edges", () => {
  const empty = fingerprintOf([])
  assert.deepEqual(empty, { count: 0, newest: null, oldest: null, clearedAt: 0 })
  assert.deepEqual(fingerprintOf([{ at: 20 }, { at: 5 }, { at: 11 }], 7), {
    count: 3,
    newest: 20,
    oldest: 5,
    clearedAt: 7,
  })
})

test("a mirror agrees only when every number agrees", () => {
  const local = { count: 2, newest: 20, oldest: 5, clearedAt: 0 }
  assert.ok(agrees(local, { ...local }))
  assert.ok(!agrees(local, { ...local, count: 3 }), "one entry more is a divergence")
  assert.ok(!agrees(local, { ...local, newest: 21 }))
  assert.ok(!agrees(local, { ...local, oldest: 4 }))
  assert.ok(!agrees(local, { ...local, clearedAt: 99 }), "a clear is a divergence even at the same count")
})

test("a clear is one clock compare, not a diff", () => {
  const rows = [{ id: "a", at: 10 }, { id: "b", at: 40 }, { id: "c", at: 41 }]
  assert.deepEqual(clearedAway(rows, 40).map((row) => row.id), ["a"])
  assert.deepEqual(clearedAway(rows, 0), [], "never cleared drops nothing")
})

test("a page upserts only what the mirror is missing or holds older", () => {
  const mirror = [{ id: "a", at: 10 }, { id: "b", at: 20 }]
  const page = [
    { id: "b", at: 20, text: "same" },
    { id: "c", at: 30, text: "new" },
  ]
  assert.deepEqual(toUpsert(mirror, page).map((row) => row.id), ["c"])
  assert.deepEqual(toUpsert(mirror, [{ id: "a", at: 11 }]).map((row) => row.id), ["a"])
  assert.deepEqual(toUpsert([], page).map((row) => row.id), ["b", "c"], "an empty mirror takes the page")
})

test("totals add up across the bots that reported", () => {
  assert.deepEqual(
    sumTotals([
      { words: 100, ms: 60_000, count: 2 },
      { words: 50, ms: 30_000, count: 1 },
    ]),
    { words: 150, ms: 90_000, count: 3 },
  )
  assert.deepEqual(sumTotals([]), { words: 0, ms: 0, count: 0 })
})

test("the rate is pooled over the totals, not averaged over takes", () => {
  assert.equal(pooledRate(600, 300_000), 120, "600 words in five minutes is 120 a minute")
  assert.equal(pooledRate(1, 60_000), 1)
  assert.equal(null, pooledRate(0, 60_000), "no words is no rate")
  assert.equal(null, pooledRate(120, 0), "no measured span is no rate")
  // A short take beside a long one: pooled stays the sum over the sum.
  const words = 3 + 300
  const ms = 2_000 + 120_000
  assert.equal(pooledRate(words, ms), Math.round(words / (ms / 60_000)))
  assert.notEqual(pooledRate(words, ms), Math.round((3 / (2_000 / 60_000) + 300 / (120_000 / 60_000)) / 2))
})
