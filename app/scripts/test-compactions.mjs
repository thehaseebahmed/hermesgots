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
const seam = (row, at, extra = {}) => ({
  id: `h-c1-${row}`,
  row,
  contentOffset: 0,
  toolsBefore: 0,
  at,
  ...extra,
})

/** The same seam at the foot of a reply whose words are `text`: nothing of it is drawn below. */
const foot = (row, at, text) => seam(row, at, { contentOffset: text.length })

const turn = (n, at) => [message(`u${n}`, "user", at), message(`a${n}`, "assistant", at + 1)]
const said = (n, at, text) => [
  message(`u${n}`, "user", at, { content: `ask ${n}` }),
  message(`a${n}`, "assistant", at + 1, { content: text }),
]
const marked = (thread, compactions) => {
  const { before, replaced } = compactionMarks(thread, compactions)
  return { before: [...before.keys()].sort(), replaced: [...replaced].sort() }
}

test("one between turns sits above the next turn", () => {
  const thread = [...said(1, 100, "first answer"), ...said(2, 200, "second answer")]
  assert.deepEqual(marked(thread, [{ at: 150 }]), { before: ["u2"], replaced: [] })
})

test("one as a turn opens sits between the user's message and the reply", () => {
  const thread = [
    ...said(1, 100, "first answer"),
    message("u2", "user", 200, { content: "ask 2" }),
    message("a2", "assistant", 210, { content: "second answer" }),
  ]
  assert.deepEqual(marked(thread, [{ at: 205 }]), { before: ["a2"], replaced: [] })
})

test("several in one gap are one divider", () => {
  const thread = [...said(1, 100, "first answer"), ...said(2, 200, "second answer")]
  assert.deepEqual(marked(thread, [{ at: 120 }, { at: 130 }]), { before: ["u2"], replaced: [] })
})

test("one is placed on the host's row time, not the row's floored createdAt", () => {
  // A catch-up floors `createdAt` forward past the mark (history.ts); the host's own time the row
  // kept decides, so a floor can't push the divider a row early.
  const thread = [
    { ...message("u1", "user", 201, { content: "ask 1" }), hermesAt: 199 },
    ...said(2, 300, "answer"),
  ]
  assert.deepEqual(marked(thread, [{ at: 200 }]), { before: ["u2"], replaced: [] })
})

test("no compactions, or none known, mark nothing", () => {
  assert.deepEqual(marked(said(1, 100, "answer"), []), { before: [], replaced: [] })
  assert.deepEqual(marked(said(1, 100, "answer"), undefined), { before: [], replaced: [] })
})

test("a divider with nothing drawn above it draws nothing", () => {
  // The top of a chat whose archive isn't loaded: the rows the compaction took away are off the
  // transcript, so a divider above the first message the device holds would be the app guessing at a
  // row it hasn't read. Loading the archive puts it back where it happened.
  assert.deepEqual(marked(said(1, 100, "answer"), [{ at: 50 }]), { before: [], replaced: [] })
  // Several of them in that gap are still nothing.
  assert.deepEqual(marked(said(1, 100, "answer"), [{ at: 20 }, { at: 50 }]), {
    before: [],
    replaced: [],
  })
})

test("a divider with nothing drawn below it draws nothing", () => {
  // A compaction the host made after everything written: the next message will carry it.
  assert.deepEqual(marked(said(1, 100, "answer"), [{ at: 500 }]), { before: [], replaced: [] })
  // A chat holding no message at all has no divider to draw either.
  assert.deepEqual(marked([], [{ at: 1 }]), { before: [], replaced: [] })
})

test("each divider carries the compaction it marks, the sized one of a gap", () => {
  const thread = [...said(1, 100, "first answer"), ...said(2, 200, "second answer")]
  const first = { at: 120, tokens: 168000, window: 200000 }
  const marks = compactionMarks(thread, [first, { at: 130, tokens: 90000 }])
  assert.deepEqual(marks.before.get("u2"), first)
  // A record that names no size loses the gap to one that does, wherever the host ordered them.
  const late = compactionMarks(thread, [{ at: 120 }, { at: 130, tokens: 90000 }])
  assert.deepEqual(late.before.get("u2"), { at: 130, tokens: 90000 })
})

test("one a reply draws inside itself draws nothing between turns", () => {
  // The seam names the row its summary became, so the divider is the reply's own and not this one's.
  const thread = [
    ...said(1, 100, "first answer"),
    message("u2", "user", 200, { content: "ask 2" }),
    message("a2", "assistant", 210, { content: "answered", seams: [seam(7, 205)] }),
    ...said(3, 300, "third answer"),
  ]
  assert.deepEqual(marked(thread, [{ at: 300, row: 7 }]), { before: [], replaced: [] })
})

test("one the record has no row for is matched to its seam by time", () => {
  // A compaction made before the plugin named a row: the seam's time is all there is.
  const thread = [
    ...said(1, 100, "first answer"),
    message("u2", "user", 200, { content: "ask 2" }),
    message("a2", "assistant", 210, { content: "answered", seams: [seam(7, 205)] }),
    ...said(3, 300, "third answer"),
  ]
  assert.deepEqual(marked(thread, [{ at: 205 }]), { before: [], replaced: [] })
  // A time further off than the host's own clock can drift is not that compaction, and a record the
  // thread has written nothing after draws nothing at all.
  assert.deepEqual(marked(thread, [{ at: 5_000 }]), { before: [], replaced: [] })
})

test("a record and a seam in one gap draw one divider between them", () => {
  // What reads today as two markers back to back: the reply's own seam at its foot, and the host's
  // record standing above the next message with nothing drawn between them. The seam is the reply's
  // and carries the size, so it is the one that stands.
  const thread = [
    ...said(1, 100, "first answer"),
    message("u2", "user", 200, { content: "ask 2" }),
    message("a2", "assistant", 210, {
      content: "second answer",
      seams: [foot(7, 205, "second answer")],
    }),
    ...said(3, 300, "third answer"),
  ]
  const sized = { at: 205, row: 7, tokens: 4_200, window: 200_000 }
  assert.deepEqual(marked(thread, [sized, { at: 250 }]), { before: [], replaced: [] })
  // The record names the size and the seam's summary is one the plugin never recorded: the record's
  // divider stands above the next message, and the reply draws none.
  assert.deepEqual(marked(thread, [{ at: 250, tokens: 4_200 }]), {
    before: ["u3"],
    replaced: ["h-c1-7"],
  })
})

test("a seam with nothing drawn on a side of it draws no divider", () => {
  // A carried turn at the top of a half-loaded chat: its request was archived, so the seam opens the
  // thread with nothing above it.
  const head = [
    message("a1", "assistant", 100, { content: "carried", seams: [seam(7, 99)] }),
    ...said(2, 200, "after"),
  ]
  assert.deepEqual(marked(head, [{ at: 99, row: 7 }]), { before: [], replaced: ["h-c1-7"] })
  // A reply still being typed: the seam sits at its foot, and nothing is drawn below it yet.
  const typing = [
    ...said(1, 100, "before"),
    message("a2", "assistant", 210, {
      content: "typing",
      status: "streaming",
      seams: [foot(8, 205, "typing")],
    }),
  ]
  assert.deepEqual(marked(typing, [{ at: 205, row: 8 }]), { before: [], replaced: ["h-c1-8"] })
})

test("a seam a call sits above and a turn below is drawn", () => {
  // The reply has said nothing but has made a call, which the reader sees: that is its side of the
  // divider, so the divider stands between the call and the turn after it.
  const thread = [
    ...said(1, 100, "before"),
    message("u2", "user", 200),
    message("a2", "assistant", 210, {
      tools: [{ toolCallId: "t1", tool: "terminal", status: "completed", contentOffset: 0 }],
      seams: [seam(7, 205, { toolsBefore: 1 })],
    }),
    ...said(3, 300, "after"),
  ]
  assert.deepEqual(marked(thread, [{ at: 205, row: 7 }]), { before: [], replaced: [] })
})
