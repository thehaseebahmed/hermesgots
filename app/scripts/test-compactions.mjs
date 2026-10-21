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

test("a compaction marks the turn it fell in", () => {
  const thread = [...turn(1, 100), ...turn(2, 200), ...turn(3, 300)]
  assert.deepEqual([...compactionMarks(thread, [{ at: 250 }])], ["u2"])
})

test("one in the newest turn marks that turn", () => {
  const thread = [...turn(1, 100), ...turn(2, 200)]
  assert.deepEqual([...compactionMarks(thread, [{ at: 999 }])], ["u2"])
})

test("several in one turn are one divider; several turns each get one", () => {
  const thread = [...turn(1, 100), ...turn(2, 200), ...turn(3, 300)]
  const marks = compactionMarks(thread, [{ at: 210 }, { at: 220 }, { at: 310 }])
  assert.deepEqual([...marks].sort(), ["u2", "u3"])
})

test("one before every loaded turn marks nothing", () => {
  const thread = [...turn(1, 100)]
  assert.equal(compactionMarks(thread, [{ at: 50 }]).size, 0)
})

test("a reply whose user row isn't loaded opens its turn", () => {
  const thread = [message("a1", "assistant", 100), ...turn(2, 200)]
  assert.deepEqual([...compactionMarks(thread, [{ at: 150 }])], ["a1"])
})

test("no compactions, or none known, mark nothing", () => {
  const thread = [...turn(1, 100)]
  assert.equal(compactionMarks(thread, []).size, 0)
  assert.equal(compactionMarks(thread, undefined).size, 0)
})
