/**
 * A chat's own flow (`lib/chat-flow.ts`), as the one rule both screens draw a chat by: its messages in
 * the thread's order, with a compaction's divider above the message it sits over, and nothing else —
 * no card, no day heading and no Moved marker, since a chat draws its own messages and a bot's chats
 * are gathered in its list rather than inside one of them (G1). Import-free, so this tier runs it
 * under plain node.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { chatFlow } from "../src/lib/chat-flow.ts"
import { compactionMarks } from "../src/lib/compactions.ts"

const message = (id, createdAt) => ({
  id,
  conversationId: "a-chat",
  role: "user",
  content: id,
  status: "done",
  createdAt,
})

const kinds = (entries) => entries.map((entry) => entry.kind)
const said = (entries) =>
  entries.map((entry) => (entry.kind === "message" ? entry.message.id : `|${entry.compaction.at}`))

test("a chat draws its own messages, in the thread's order, and nothing between them", () => {
  const thread = [message("m1", 10), message("m2", 20), message("m3", 30)]
  const entries = chatFlow({ thread })
  assert.deepEqual(kinds(entries), ["message", "message", "message"])
  assert.deepEqual(said(entries), ["m1", "m2", "m3"], "each message once, where the thread holds it")
  assert.deepEqual(
    entries.map((entry) => entry.message.createdAt),
    [10, 20, 30],
    "in the order the thread gives, never re-sorted",
  )
})

test("a chat with nothing said draws nothing at all", () => {
  assert.deepEqual(chatFlow({}), [])
  assert.deepEqual(chatFlow({ thread: [] }), [])
})

test("a compaction's divider stands above the message it sits over, and above no other", () => {
  const thread = [message("m1", 10), message("m2", 20), message("m3", 30)]
  const compacted = compactionMarks(thread, [{ at: 15, tokens: 4000 }])
  const entries = chatFlow({ thread, compacted })
  assert.deepEqual(
    said(entries),
    ["m1", "|15", "m2", "m3"],
    "the divider is the entry above the first message written after the compaction",
  )
  assert.deepEqual(kinds(entries), ["message", "compaction", "message", "message"])
  assert.equal(entries[1].compaction.tokens, 4000, "and it carries the compaction it marks")
  assert.equal(entries[1].at, 15, "drawn at the time the host recorded it")
})

test("a compaction the record keeps off the thread draws no divider", () => {
  const thread = [message("m1", 10)]
  // Made after everything written: no message sits below it to carry a divider (ADR 0058).
  const compacted = compactionMarks(thread, [{ at: 40, tokens: 4000 }])
  assert.deepEqual(kinds(chatFlow({ thread, compacted })), ["message"])
})

test("no entry is a card, a day heading or a moved marker: a chat draws messages and dividers", () => {
  const thread = [message("m1", 10), message("m2", 20), message("m3", 30)]
  const compacted = compactionMarks(thread, [{ at: 15 }])
  const entries = chatFlow({ thread, compacted })
  for (const entry of entries)
    assert.ok(
      entry.kind === "message" || entry.kind === "compaction",
      `a chat draws no ${entry.kind} (G1: a bot's chats are gathered in its list, not inside one of them)`,
    )
  assert.equal(
    entries.length,
    thread.length + 1,
    "one entry per message, plus the one divider: nothing is placed among them",
  )
})

test("a mark stands above the first message that came after it", () => {
  // A build's visits are marks in its run: each one happened at a time the host stamped, and the
  // message that follows it is where the work of that visit begins.
  const thread = [message("m1", 10), message("m2", 20), message("m3", 30)]
  const marks = [
    { at: 5, words: "Planning · 2.0s" },
    { at: 20, words: "Checking · Checks passed · 1.0s", flag: "passing" },
  ]
  const entries = chatFlow({ thread, marks })
  assert.deepEqual(kinds(entries), ["mark", "message", "mark", "message", "message"])
  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "message" ? entry.message.id : `|${entry.words}`,
    ),
    ["|Planning · 2.0s", "m1", "|Checking · Checks passed · 1.0s", "m2", "m3"],
    "a mark before every message stands at the top, and one stamped in a message's own second stands above it",
  )
})

test("a mark after every message stands at the foot of the run", () => {
  const thread = [message("m1", 10)]
  const entries = chatFlow({ thread, marks: [{ at: 40, words: "Publishing" }] })
  assert.deepEqual(kinds(entries), ["message", "mark"])
  assert.equal(entries[1].words, "Publishing", "the visit the run has not reached yet ends it")
})

test("a run with no marks is the flow it was, and a mark on a thread with nothing said still stands", () => {
  assert.deepEqual(chatFlow({ thread: [message("m1", 10)] }), [
    { kind: "message", message: message("m1", 10) },
  ])
  assert.deepEqual(kinds(chatFlow({ marks: [{ at: 5, words: "Planning" }] })), ["mark"])
})
