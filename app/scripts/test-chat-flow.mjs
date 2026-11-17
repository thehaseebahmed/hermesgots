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

const marker = (id, at) => ({ id, at, text: `Routine "${id}" ran` })
const order = (entries) =>
  entries.map((entry) =>
    entry.kind === "message" ? entry.message.id : entry.kind === "routine" ? `~${entry.marker.id}` : "|",
  )

test("a routine's marker stands among Main's messages by time, and is no message", () => {
  const thread = [message("m1", 10), message("m2", 30)]
  const entries = chatFlow({ thread, routines: [marker("r1", 20), marker("r2", 40)] })
  assert.deepEqual(order(entries), ["m1", "~r1", "m2", "~r2"])
  assert.deepEqual(
    thread.map((m) => m.id),
    ["m1", "m2"],
    "the thread itself holds no marker",
  )
})

test("a marker older than every message opens the flow, and a Main with no messages holds its markers", () => {
  assert.deepEqual(order(chatFlow({ thread: [message("m1", 50)], routines: [marker("r1", 5)] })), ["~r1", "m1"])
  assert.deepEqual(order(chatFlow({ routines: [marker("r1", 5), marker("r2", 6)] })), ["~r1", "~r2"])
})
