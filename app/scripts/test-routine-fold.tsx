/**
 * A routine's message in the current chat's fold: `history.ts` starts a message of its own for it
 * rather than letting its words join the reply above (ADR 0081).
 *
 * Driven here rather than from the unit tier because `history.ts` imports through the app's `@/`
 * aliases, which the bare `node --experimental-strip-types` runner cannot resolve; the new thread's
 * half of the rule is `test-routine-fold.mjs`.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { toMessages, turnsFromRows } from "@/lib/history"
import type { SessionMessage } from "@/lib/hermes"

const SESSION = "routine-session"
const AT = 1_760_000_000

const row = (
  id: number,
  role: SessionMessage["role"],
  content: string,
  extra: Partial<SessionMessage> = {},
): SessionMessage => ({ id, role, content, timestamp: AT, ...extra })

/** A routine's row as the plugin writes it: an assistant row whose display kind says so, and whose
 * display metadata names the delivery it came from. */
const routine = (id: number, content: string, extra: Partial<SessionMessage> = {}) =>
  row(id, "assistant", content, {
    display_kind: "routine_message",
    display_metadata: { routine: { execution: "job-1:cron_job-1_9" } },
    ...extra,
  })

const drawn = (rows: SessionMessage[]) => toMessages("c-1", SESSION, rows)

test("a request, a finished reply and a routine row make three messages", () => {
  const messages = drawn([
    row(1, "user", "check the feeds"),
    row(2, "assistant", "Working through the feeds."),
    routine(3, "Morning watch: three new items."),
  ])
  assert.deepEqual(
    messages.map((one) => `${one.role}: ${one.content}`),
    [
      "user: check the feeds",
      "assistant: Working through the feeds.",
      "assistant: Morning watch: three new items.",
    ],
    "the routine's words are a message of their own, never carried on the reply above",
  )
})

test("a routine's message is marked as one, and names the row it came from", () => {
  const messages = drawn([
    row(1, "user", "check the feeds"),
    row(2, "assistant", "Working through the feeds."),
    routine(3, "Morning watch: three new items."),
  ])
  const [, reply, message] = messages
  assert.equal(reply.routine, undefined, "a plain reply draws no routine chip")
  assert.equal(reply.hermesRowId, undefined)
  assert.equal(message.routine, true)
  assert.equal(message.hermesRowId, 3)
  assert.equal(message.role, "assistant")
  assert.notEqual(message.id, reply.id, "two messages, not one")
})

test("a routine row with no request above it still draws as one message", () => {
  const messages = drawn([routine(9, "The build is green.")])
  assert.equal(messages.length, 1)
  const [message] = messages
  assert.equal(message.role, "assistant")
  assert.equal(message.content, "The build is green.")
  assert.equal(message.routine, true)
  assert.equal(message.hermesRowId, 9)
})

test("a routine row leaves the reply's own tool rows alone", () => {
  const messages = drawn([
    row(1, "user", "check the feeds"),
    row(2, "assistant", "Reading the feed.", {
      tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }],
    }),
    row(3, "tool", "three items", { tool_call_id: "call-1" }),
    routine(4, "Morning watch: three new items."),
  ])
  const [, reply, message] = messages
  assert.equal(reply.content, "Reading the feed.")
  assert.deepEqual(
    (reply.tools ?? []).map((tool) => tool.toolCallId),
    ["call-1"],
    "the call stays on the reply it was made in",
  )
  assert.equal(message.content, "Morning watch: three new items.")
  assert.deepEqual(message.tools ?? [], [])
})

test("a routine's row is a turn of its own, which is what the catch-up keeps", () => {
  // The catch-up writes one reply per turn, so a routine row sharing the reply's turn would be left
  // out of the thread entirely — the row is cut into a turn with no request of the user's.
  const turns = turnsFromRows([
    row(1, "user", "check the feeds"),
    row(2, "assistant", "Working through the feeds."),
    routine(3, "Morning watch: three new items."),
  ])
  assert.equal(turns.length, 2, "the request's turn, then the routine's own")
  assert.equal(turns[0].request?.id, 1)
  assert.equal(turns[1].request, undefined, "the routine's turn asks nothing of the user")
  assert.deepEqual(
    turns[1].rows.map((one) => one.id),
    [3],
  )
})

test("a carried copy of a routine's message lands on the message already drawn", () => {
  // A rotated compaction re-emits the row under a fresh id: the message is named after its delivery,
  // so the copy is the same message rather than a second one beside it.
  const before = drawn([
    row(1, "user", "check the feeds"),
    routine(3, "Morning watch: three new items."),
  ])
  const after = drawn([
    row(1, "user", "check the feeds"),
    routine(9, "Morning watch: three new items.", { timestamp: AT + 60 }),
  ])
  assert.equal(before[1].id, after[1].id, "one id across the compaction")
  assert.notEqual(before[1].hermesRowId, after[1].hermesRowId, "while the row it points at moved")
})
