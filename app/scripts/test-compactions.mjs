import assert from "node:assert/strict"
import test from "node:test"

import { compactionMarks } from "../src/lib/compactions.ts"

const message = (id, role, createdAt) => ({
  id,
  conversationId: "c1",
  role,
  content: "",
  status: "done",
  createdAt,
})

const turn = (n, at) => [message(`u${n}`, "user", at), message(`a${n}`, "assistant", at + 1)]
const marked = (thread, compactions) => {
  const { before, trailing } = compactionMarks(thread, compactions)
  return { before: [...before].sort(), trailing }
}

test("one between turns sits above the next turn", () => {
  const thread = [...turn(1, 100), ...turn(2, 200)]
  assert.deepEqual(marked(thread, [{ at: 150 }]), { before: ["u2"], trailing: false })
})

test("one as a turn opens sits between the user's message and the reply", () => {
  const thread = [...turn(1, 100), message("u2", "user", 200), message("a2", "assistant", 210)]
  assert.deepEqual(marked(thread, [{ at: 205 }]), { before: ["a2"], trailing: false })
})

test("one after everything closes the thread", () => {
  const thread = [...turn(1, 100)]
  assert.deepEqual(marked(thread, [{ at: 500 }]), { before: [], trailing: true })
})

test("several in one gap are one divider", () => {
  const thread = [...turn(1, 100), ...turn(2, 200)]
  assert.deepEqual(marked(thread, [{ at: 120 }, { at: 130 }]), { before: ["u2"], trailing: false })
})

test("one before every loaded message marks nothing", () => {
  assert.deepEqual(marked(turn(1, 100), [{ at: 50 }]), { before: [], trailing: false })
})

test("no compactions, or none known, mark nothing", () => {
  assert.deepEqual(marked(turn(1, 100), []), { before: [], trailing: false })
  assert.deepEqual(marked(turn(1, 100), undefined), { before: [], trailing: false })
  assert.deepEqual(marked([], [{ at: 1 }]), { before: [], trailing: false })
})
