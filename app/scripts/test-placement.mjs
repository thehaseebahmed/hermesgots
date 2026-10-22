import assert from "node:assert/strict"
import test from "node:test"

import { place } from "../src/lib/placement.ts"

const message = (id, createdAt) => ({
  id,
  conversationId: "main-bot-1",
  role: "user",
  content: id,
  status: "done",
  createdAt,
})

const thing = (id, at) => ({ id, at })
const at = (one) => one.at
const above = (placed, id) => (placed.before.get(id) ?? []).map((one) => one.id)
const trailing = (placed) => placed.trailing.map((one) => one.id)

test("a thing sits above the first message written after it", () => {
  const placed = place([message("m5", 5), message("m20", 20)], [thing("at10", 10)], at)
  assert.deepEqual(above(placed, "m20"), ["at10"])
  assert.deepEqual(above(placed, "m5"), [])
})

test("a thing after every message trails the flow", () => {
  const placed = place([message("m5", 5)], [thing("at10", 10)], at)
  assert.deepEqual(trailing(placed), ["at10"])
  assert.equal(placed.before.size, 0)
})

test("a thing at the same moment as a message is drawn below it", () => {
  const placed = place([message("m10", 10), message("m20", 20)], [thing("also10", 10)], at)
  assert.deepEqual(above(placed, "m10"), [])
  assert.deepEqual(above(placed, "m20"), ["also10"], "written after, so it goes above the next")
})

test("things placed above one message keep the order they were given in", () => {
  const placed = place(
    [message("m5", 5), message("m40", 40)],
    [thing("at10", 10), thing("at20", 20), thing("at30", 30)],
    at,
  )
  assert.deepEqual(above(placed, "m40"), ["at10", "at20", "at30"])
})

test("a thread with no messages draws every thing after nothing", () => {
  const placed = place([], [thing("at10", 10), thing("at20", 20)], at)
  assert.deepEqual(trailing(placed), ["at10", "at20"])
})
