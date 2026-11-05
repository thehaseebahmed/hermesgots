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

test("the chosen order runs inside every group, and flat across everything filtered", () => {
  const grouped = codeGroups(
    [
      { id: "a", state: "idle", at: 3, act: 9, title: "Zebra" },
      { id: "b", state: "waiting", at: 1, act: 20, title: "apple" },
      { id: "c", state: "idle", at: 2, act: 15, title: "Mango" },
    ],
    (r) => codeGroupOf(r.state),
    codeOrder(at("title"), pick),
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
    [...grouped.flatMap((group) => group.items)].sort(codeOrder(at("activity"), pick)).map((r) => r.id),
    ["b", "c", "a"],
    "flat across groups under the same choice",
  )
})

test("a pinned session is drawn in the band above the four and leaves its own group", () => {
  const groups = codeGroups(
    [
      { id: "pinned", state: "waiting", at: 1 },
      { id: "waits", state: "waiting", at: 2 },
      { id: "rests", state: "idle", at: 3 },
    ],
    (r) => codeGroupOf(r.state),
    (a, b) => b.at - a.at,
    (r) => r.id === "pinned",
  )
  assert.deepEqual(
    groups.map((g) => [g.key, g.label, g.items.map((r) => r.id)]),
    [
      ["pinned", "Pinned", ["pinned"]],
      ["waiting", "Waiting for You", ["waits"]],
      ["idle", "Idle", ["rests"]],
    ],
    "the band comes first and the row is not drawn in its group as well",
  )
})

test("the band runs the order the list is handed, so the dropdown means one thing", () => {
  const groups = codeGroups(
    [
      { id: "c", state: "idle", at: 3 },
      { id: "a", state: "idle", at: 1 },
      { id: "b", state: "idle", at: 2 },
    ],
    (r) => codeGroupOf(r.state),
    (x, y) => x.at - y.at,
    () => true,
  )
  assert.deepEqual(
    groups.map((g) => g.key),
    ["pinned"],
    "every row is pinned and the four are empty, so only the band stands",
  )
  assert.deepEqual(
    groups[0].items.map((r) => r.id),
    ["a", "b", "c"],
    "oldest first, the comparator it was handed",
  )
})

test("with nothing pinned, the list is the four groups exactly as before", () => {
  const groups = codeGroups(
    [
      row("a", "idle", 1),
      row("b", "waiting", 2),
      row("c", "resolved", 3),
      row("d", "working", 4),
    ],
    (r) => codeGroupOf(r.state),
    (x, y) => y.createdAt - x.createdAt,
    () => false,
  )
  assert.deepEqual(
    groups.map((g) => [g.key, g.label, g.items.map((r) => r.id)]),
    [
      ["waiting", "Waiting for You", ["b"]],
      ["working", "Working", ["d"]],
      ["idle", "Idle", ["a"]],
      ["closed", "Closed", ["c"]],
    ],
    "the four keys, their labels, their order and their members, and no band above them",
  )
})
