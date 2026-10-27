import assert from "node:assert/strict"
import test from "node:test"

import { compactionMarks } from "../src/lib/compactions.ts"

const message = (id, role, createdAt, extra = {}) => ({
  id,
  conversationId: "c1",
  role,
  content: "",
  status: "done",
  createdAt,
  ...extra,
})

/** A reply that draws a compaction inside itself: the seam the thread splits it at. */
const seam = (row, at) => ({
  id: `h-c1-${row}`,
  row,
  contentOffset: 0,
  toolsBefore: 0,
  at,
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

test("one is placed on the host's row time, not the row's floored createdAt", () => {
  // A catch-up floors `createdAt` forward past the mark (history.ts); the host's own time the row
  // kept decides, so a floor can't push the divider a row early.
  const thread = [{ ...message("u1", "user", 201), hermesAt: 199 }, ...turn(2, 300)]
  assert.deepEqual(marked(thread, [{ at: 200 }]), { before: ["u2"], trailing: false })
})

test("several before every loaded message are one divider", () => {
  const thread = turn(1, 100)
  assert.deepEqual(marked(thread, [{ at: 20 }, { at: 50 }]), { before: ["u1"], trailing: false })
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
  const head = compactionMarks(turn(1, 100), [{ at: 20 }, { at: 50 }])
  assert.deepEqual(head.before.get("u1"), { at: 20 })
  const last = compactionMarks(thread, [{ at: 500, tokens: 7 }])
  assert.deepEqual(last.trailing, { at: 500, tokens: 7 })
})

test("one a reply draws inside itself draws nothing between turns", () => {
  // The seam names the row its summary became, so the divider is the reply's own and not this one's.
  const thread = [
    ...turn(1, 100),
    message("u2", "user", 200),
    message("a2", "assistant", 210, { seams: [seam(7, 205)] }),
  ]
  assert.deepEqual(marked(thread, [{ at: 300, row: 7 }]), { before: [], trailing: false })
})

test("one the record has no row for is matched to its seam by time", () => {
  // A compaction made before the plugin named a row: the seam's time is all there is.
  const thread = [
    ...turn(1, 100),
    message("u2", "user", 200),
    message("a2", "assistant", 210, { seams: [seam(7, 205)] }),
  ]
  assert.deepEqual(marked(thread, [{ at: 205 }]), { before: [], trailing: false })
  // A time further off than the host's own clock can drift is not that compaction.
  assert.deepEqual(marked(thread, [{ at: 5_000 }]), { before: [], trailing: true })
})
