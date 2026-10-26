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
  return { before: [...before.keys()].sort(), trailing: trailing !== undefined }
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

test("one before every loaded message stands above the first", () => {
  // What a device that never saw those messages has: Hermes keeps the rows a compaction took away
  // off the transcript, so the top of what it can load is where the compaction happened.
  assert.deepEqual(marked(turn(1, 100), [{ at: 50 }]), { before: ["u1"], trailing: false })
})

test("several before every loaded message are one divider, the first's", () => {
  const thread = turn(1, 100)
  assert.deepEqual(marked(thread, [{ at: 20 }, { at: 50 }]), { before: ["u1"], trailing: false })
  assert.deepEqual(compactionMarks(thread, [{ at: 20 }, { at: 50 }]).before.get("u1"), { at: 20 })
})

test("no compactions, or none known, mark nothing", () => {
  assert.deepEqual(marked(turn(1, 100), []), { before: [], trailing: false })
  assert.deepEqual(marked(turn(1, 100), undefined), { before: [], trailing: false })
  assert.deepEqual(marked([], [{ at: 1 }]), { before: [], trailing: false })
})

test("each divider carries the compaction it marks, the first of a gap", () => {
  const thread = [...turn(1, 100), ...turn(2, 200)]
  const first = { at: 120, tokens: 168000, window: 200000 }
  const marks = compactionMarks(thread, [first, { at: 130, tokens: 90000 }])
  assert.deepEqual(marks.before.get("u2"), first)
  const last = compactionMarks(thread, [{ at: 500, tokens: 7 }])
  assert.deepEqual(last.trailing, { at: 500, tokens: 7 })
})
