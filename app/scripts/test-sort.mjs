/**
 * A sort is a key and a direction (ADR 0091): each key carries the arrow it reads best in, a second
 * tap on the chosen key flips that arrow, another key is picked at its own, and a value an older
 * build wrote — the direction baked into the key — is read as the key and arrow it meant.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { defaultSort, readSort, toggleSort, withDir } from "../src/lib/sort.ts"

const KEYS = [
  { key: "date", label: "Newest", dir: "desc" },
  { key: "name", label: "Name", dir: "asc" },
]

const LEGACY = {
  new: { key: "date", dir: "desc" },
  old: { key: "date", dir: "asc" },
  az: { key: "name", dir: "asc" },
  za: { key: "name", dir: "desc" },
}

test("a key is picked at the arrow it reads best in", () => {
  assert.deepEqual(defaultSort(KEYS), { key: "date", dir: "desc" })
  assert.deepEqual(defaultSort(KEYS, "name"), { key: "name", dir: "asc" })
  assert.deepEqual(defaultSort(KEYS, "nonsense"), { key: "date", dir: "desc" })
})

test("tapping the chosen key flips its arrow, and another key is picked at its own", () => {
  const now = { key: "date", dir: "desc" }
  assert.deepEqual(toggleSort(now, "date", KEYS), { key: "date", dir: "asc" }, "the same key flips")
  assert.deepEqual(
    toggleSort({ key: "date", dir: "asc" }, "date", KEYS),
    { key: "date", dir: "desc" },
    "and flips back",
  )
  assert.deepEqual(toggleSort(now, "name", KEYS), { key: "name", dir: "asc" }, "a new key, its own")
})

test("what a device stored is read as a key and an arrow", () => {
  assert.deepEqual(readSort(KEYS, { key: "name", dir: "asc" }), { key: "name", dir: "asc" })
  assert.deepEqual(
    readSort(KEYS, { key: "name" }),
    { key: "name", dir: "asc" },
    "a key with no arrow takes the key's own",
  )
  assert.deepEqual(
    readSort(KEYS, { key: "name", dir: "sideways" }),
    { key: "name", dir: "asc" },
    "an arrow nothing understands is no arrow",
  )
})

test("an older build's value keeps the order it meant", () => {
  assert.deepEqual(readSort(KEYS, { key: "old" }, LEGACY), { key: "date", dir: "asc" })
  assert.deepEqual(readSort(KEYS, { key: "za" }, LEGACY), { key: "name", dir: "desc" })
  assert.deepEqual(readSort(KEYS, {}, LEGACY), { key: "date", dir: "desc" }, "unset: the first key")
  assert.deepEqual(
    readSort(KEYS, { key: "old", dir: "desc" }, LEGACY),
    { key: "date", dir: "asc" },
    "the old key decides: its own arrow is what it meant",
  )
})

test("a comparator's answer is read in the arrow", () => {
  assert.equal(withDir(-5, "asc"), -5)
  assert.equal(withDir(-5, "desc"), 5)
  assert.equal(withDir(0, "desc"), 0)
})
