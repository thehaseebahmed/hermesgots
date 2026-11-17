/**
 * The Code list's order: created, last activity or title, each in the arrow the reader picked, run
 * flat over every row.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { codeOrder } from "../src/lib/item-groups.ts"

const pick = { created: (r) => r.at, activity: (r) => r.act, title: (r) => r.title }
const mixed = [
  { id: "a", at: 3, act: 9, title: "Zebra" },
  { id: "b", at: 1, act: 20, title: "apple" },
  { id: "c", at: 2, act: 15, title: "Mango" },
]
const at = (key) => ({ key, dir: key === "title" ? "asc" : "desc" })
const ids = (sort, rows = mixed) =>
  [...rows].sort(codeOrder(typeof sort === "string" ? at(sort) : sort, pick)).map((r) => r.id)

test("created runs newest first by default, activity newest first, title A–Z", () => {
  assert.deepEqual(ids("created"), ["a", "c", "b"], "newest created first")
  assert.deepEqual(ids("activity"), ["b", "c", "a"], "the newest activity first")
  assert.deepEqual(ids("title"), ["b", "c", "a"], "A–Z, case-insensitively")
})

test("the arrow turns a group's order round, and its tie-break with it", () => {
  assert.deepEqual(ids({ key: "title", dir: "desc" }), ["a", "c", "b"], "Z to A")
  assert.deepEqual(ids({ key: "created", dir: "asc" }), ["b", "c", "a"], "oldest created first")
})

