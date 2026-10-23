import assert from "node:assert/strict"
import test from "node:test"

import { moveMarks } from "../src/lib/move-marks.ts"

const message = (id, createdAt) => ({
  id,
  conversationId: "main-bot-1",
  role: "user",
  content: id,
  status: "done",
  createdAt,
})

const move = (id, at, extra = {}) => ({
  id,
  text: `text of ${id}`,
  threadId: "t1",
  at,
  undone: false,
  undoable: true,
  ...extra,
})

const cards = (...ids) => new Set(ids)

const above = (marks, id) => (marks.before.get(id) ?? []).map((one) => one.id)
const trailing = (marks) => marks.trailing.map((one) => one.id)

test("a move into an older thread draws its marker above the next message", () => {
  const marks = moveMarks([message("m5", 5), message("m20", 20)], [move("m10", 10)], cards())
  assert.deepEqual(above(marks, "m20"), ["m10"])
  assert.deepEqual(above(marks, "m5"), [])
})

test("a move that opened a new thread draws no marker where that thread's card is drawn", () => {
  const marks = moveMarks(
    [message("m5", 5), message("m20", 20)],
    [move("m10", 10, { new: true })],
    cards("t1"),
  )
  assert.deepEqual(above(marks, "m20"), [])
  assert.equal(marks.before.size, 0)
  assert.deepEqual(trailing(marks), [])
})

test("a new-thread move whose card is not drawn keeps its marker", () => {
  const marks = moveMarks(
    [message("m5", 5), message("m20", 20)],
    [move("m10", 10, { new: true })],
    cards(),
  )
  assert.deepEqual(above(marks, "m20"), ["m10"])
  assert.equal(marks.before.size, 1)
})

test("only the older-thread moves draw a marker when both are in the same hour", () => {
  const marks = moveMarks(
    [message("m5", 5), message("m30", 30)],
    [
      move("opened-a-thread", 10, { threadId: "n1", new: true }),
      move("joined-an-older-thread", 20),
    ],
    cards("n1"),
  )
  assert.deepEqual(above(marks, "m30"), ["joined-an-older-thread"])
  assert.equal(marks.before.size, 1)
})

test("a new-thread move after every message draws nothing at the end where its card is drawn", () => {
  const carded = moveMarks([message("m5", 5)], [move("m10", 10, { new: true })], cards("t1"))
  assert.deepEqual(trailing(carded), [])
  const uncarded = moveMarks([message("m5", 5)], [move("m10", 10, { new: true })], cards())
  assert.deepEqual(trailing(uncarded), ["m10"], "an uncarded move keeps its marker at the end")
})

test("an undone move draws nothing, whether it opened a thread or joined one", () => {
  const marks = moveMarks(
    [message("m5", 5), message("m20", 20)],
    [
      move("m10", 10, { undone: true, undoable: false }),
      move("m12", 12, { new: true, undone: true, undoable: false }),
    ],
    cards(),
  )
  assert.equal(marks.before.size, 0)
  assert.deepEqual(trailing(marks), [])
})

test("markers keep the order they were made in, and a move's own thread does not matter", () => {
  const marks = moveMarks(
    [message("m5", 5), message("m40", 40)],
    [
      move("m10", 10, { threadId: "t-a" }),
      move("m20", 20, { threadId: "t-b", new: true }),
      move("m30", 30, { threadId: "t-a" }),
    ],
    cards("t-b"),
  )
  assert.deepEqual(above(marks, "m40"), ["m10", "m30"])
})
