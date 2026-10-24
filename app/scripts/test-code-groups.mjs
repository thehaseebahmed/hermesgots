/**
 * The Code list's four groups: Waiting for You, Working, Idle, Closed — in that fixed order, empty
 * groups dropped, and each group's sessions sorted on their own (created, newest first, unless the
 * sort-by dropdown says otherwise), so one group's order never reaches into another's.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { codeGroupOf, codeGroups, codeOrder } from "../src/lib/item-groups.ts"

const row = (id, state, createdAt) => ({ id, state, createdAt })

test("Resolved and Discarded share Closed; the other three pass through as they are", () => {
  assert.equal(codeGroupOf("resolved"), "closed")
  assert.equal(codeGroupOf("discarded"), "closed")
  assert.equal(codeGroupOf("waiting"), "waiting")
  assert.equal(codeGroupOf("working"), "working")
  assert.equal(codeGroupOf("idle"), "idle")
})

test("the groups always run Waiting for You, Working, Idle, Closed, with their labels", () => {
  const groups = codeGroups(
    [row("a", "idle", 1), row("b", "working", 2), row("c", "waiting", 3), row("d", "discarded", 4)],
    (r) => codeGroupOf(r.state),
    (a, b) => b.createdAt - a.createdAt,
  )
  assert.deepEqual(
    groups.map((g) => [g.key, g.label]),
    [
      ["waiting", "Waiting for You"],
      ["working", "Working"],
      ["idle", "Idle"],
      ["closed", "Closed"],
    ],
  )
  assert.deepEqual(
    groups.map((g) => g.items.map((r) => r.id)),
    [["c"], ["b"], ["a"], ["d"]],
  )
})

test("empty groups are left out, so no heading ever has nothing under it", () => {
  const groups = codeGroups([row("a", "idle", 1)], (r) => codeGroupOf(r.state), () => 0)
  assert.deepEqual(
    groups.map((g) => g.key),
    ["idle"],
  )
})

test("within a group the sessions run created, newest first, whichever group they are in", () => {
  const groups = codeGroups(
    [
      row("old", "waiting", 10),
      row("new", "idle", 30),
      row("mid", "waiting", 20),
      row("only", "working", 5),
    ],
    (r) => codeGroupOf(r.state),
    (a, b) => b.createdAt - a.createdAt,
  )
  assert.deepEqual(
    groups.map((g) => [g.key, g.items.map((r) => r.id)]),
    [
      ["waiting", ["mid", "old"]],
      ["working", ["only"]],
      ["idle", ["new"]],
    ],
  )
})

test("the order is whatever the caller passes — the dropdown's other choices ride the same path", () => {
  const byTitle = codeGroups(
    [row("b", "idle", 1), row("a", "idle", 2)],
    (r) => codeGroupOf(r.state),
    (x, y) => x.id.localeCompare(y.id),
  )
  assert.deepEqual(
    byTitle[0].items.map((r) => r.id),
    ["a", "b"],
  )
})

// The sort-by dropdown's own three orders.

const pick = { created: (r) => r.at, activity: (r) => r.act, title: (r) => r.title }
const mixed = [
  { id: "a", at: 3, act: 9, title: "Zebra" },
  { id: "b", at: 1, act: 20, title: "apple" },
  { id: "c", at: 2, act: 15, title: "Mango" },
]
const ids = (sort, rows = mixed) => [...rows].sort(codeOrder(sort, pick)).map((r) => r.id)

test("created runs newest first by default, activity newest first, title A–Z", () => {
  assert.deepEqual(ids("created"), ["a", "c", "b"], "newest created first")
  assert.deepEqual(ids("activity"), ["b", "c", "a"], "the newest activity first")
  assert.deepEqual(ids("title"), ["b", "c", "a"], "A–Z, case-insensitively")
})

test("the chosen order runs inside every group, and flat across everything filtered", () => {
  const grouped = codeGroups(
    [
      { id: "a", state: "idle", at: 3, act: 9, title: "Zebra" },
      { id: "b", state: "waiting", at: 1, act: 20, title: "apple" },
      { id: "c", state: "idle", at: 2, act: 15, title: "Mango" },
    ],
    (r) => codeGroupOf(r.state),
    codeOrder("title", pick),
  )
  assert.deepEqual(
    grouped.map((group) => [group.key, group.items.map((r) => r.id)]),
    [
      ["waiting", ["b"]],
      ["idle", ["c", "a"]],
    ],
    "each group A–Z on its own",
  )
  assert.deepEqual(
    [...grouped.flatMap((group) => group.items)].sort(codeOrder("activity", pick)).map((r) => r.id),
    ["b", "c", "a"],
    "flat across groups under the same choice",
  )
})
