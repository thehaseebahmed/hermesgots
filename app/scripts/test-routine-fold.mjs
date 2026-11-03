/**
 * A routine's answer is the bot's own message, so the new thread's fold opens a turn of its own for
 * it rather than letting its words join the reply above (ADR 0081).
 *
 * The current chat's half of the rule is `test-routine-fold.tsx`: `history.ts` imports through the
 * app's `@/` aliases, which the bare `node --experimental-strip-types` runner cannot resolve, so its
 * cases run under the component tier's loader.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { foldTurns } from "../src/chat-next/fold.ts"
import { messagesOf } from "../src/chat-next/messages.ts"

const row = (id, role, content, extra = {}) => ({ id, role, content, ...extra })

/** A routine's row as the plugin writes it: an assistant row whose display kind says so. */
const routine = (id, content, extra = {}) =>
  row(id, "assistant", content, {
    display_kind: "routine_message",
    finish_reason: "stop",
    ...extra,
  })

const kinds = (turn) => turn.parts.map((part) => part.kind)
const words = (turn) =>
  turn.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n\n")

test("a routine's answer is a turn of its own, not more of the reply above it", () => {
  const turns = foldTurns([
    row(1, "user", "check the feeds", { timestamp: 100 }),
    row(2, "assistant", "Working through the feeds.", { timestamp: 101, finish_reason: "stop" }),
    routine(3, "Morning watch: three new items.", { timestamp: 102 }),
  ])
  assert.equal(turns.length, 2, "the request with its reply, then the routine's own message")
  const [reply, message] = turns
  assert.equal(reply.user, "check the feeds")
  assert.deepEqual(kinds(reply), ["text"])
  assert.equal(words(reply), "Working through the feeds.", "the reply keeps only its own words")
  assert.equal(reply.done, true)
  assert.equal(reply.routine, undefined, "a plain reply draws no routine chip")
  assert.equal(message.user, "", "a routine's message answers no request")
  assert.deepEqual(kinds(message), ["text"], "its words are that turn's only part")
  assert.equal(words(message), "Morning watch: three new items.")
  assert.equal(message.routine, true, "the turn says so, which is what the chip is drawn from")
})

test("a routine row on its own draws as one message", () => {
  const turns = foldTurns([routine(7, "The build is green.", { timestamp: 200 })])
  assert.equal(turns.length, 1)
  const [message] = turns
  assert.equal(message.user, "")
  assert.equal(words(message), "The build is green.")
  assert.equal(message.routine, true)
})

test("a routine's message is dated the time its row was written", () => {
  const at = Date.UTC(2026, 10, 3, 6, 0)
  const [turn] = foldTurns([
    routine(3, "Morning watch: three new items.", { timestamp: at / 1000 }),
  ])
  assert.equal(turn.at, at, "the turn keeps its row's time, in ms")
  const [message] = messagesOf("chat-1", [turn])
  assert.equal(message.createdAt, at, "a message with no request above it is dated its own row")
})

test("a routine's row the host didn't time leaves the turn undated", () => {
  const [turn] = foldTurns([routine(4, "Morning watch: three new items.")])
  assert.equal(turn.at, undefined, "nothing is invented for a row with no time of its own")
})

test("a routine row sets its own turn's done, never the reply's above it", () => {
  const rows = [
    row(1, "user", "check the feeds", { timestamp: 100 }),
    row(2, "assistant", "Working through the feeds.", { timestamp: 101, finish_reason: "stop" }),
    routine(3, "Morning watch: three new items.", { timestamp: 102, finish_reason: null }),
  ]
  const [reply, message] = foldTurns(rows)
  assert.equal(words(reply), "Working through the feeds.")
  // Its row names no finish reason, so its turn is still open — the same rule every reply's done has.
  assert.equal(message.done, false)
  assert.equal(message.failed, undefined)
})

test("a routine row after a compaction opens a turn of its own, leaving the seam above it", () => {
  const turns = foldTurns([
    row(1, "user", "check the feeds", { timestamp: 100 }),
    row(2, "assistant", "Working through the feeds.", { timestamp: 101, finish_reason: "stop" }),
    // The host's compaction summary: a hidden user row, which carries the divider.
    row(3, "user", "Summary of the conversation so far.", {
      timestamp: 102,
      display_kind: "hidden",
    }),
    routine(4, "Morning watch: three new items.", { timestamp: 103 }),
  ])
  assert.equal(turns.length, 2, "the carried reply, then the routine's own turn")
  const [reply, message] = turns
  assert.deepEqual(kinds(reply), ["text", "compaction"], "the divider closes the reply above")
  assert.equal(words(reply), "Working through the feeds.")
  assert.deepEqual(kinds(message), ["text"], "the routine's words never join the carried reply")
  assert.equal(words(message), "Morning watch: three new items.")
  assert.equal(message.routine, true)
})

test("a routine row the host carried across a compaction is not drawn twice, and leaves no turn", () => {
  const said = "Morning watch: three new items."
  const turns = foldTurns([
    row(1, "user", "check the feeds", { timestamp: 100 }),
    row(2, "assistant", "Working through the feeds.", { timestamp: 101, finish_reason: "stop" }),
    routine(3, said, { timestamp: 102 }),
    row(4, "user", "Summary of the conversation so far.", {
      timestamp: 103,
      display_kind: "hidden",
    }),
    // The same message re-emitted under a fresh row id, which is how a compaction carries work.
    routine(9, said, { timestamp: 104 }),
  ])
  assert.equal(turns.length, 2, "the copy opens no third turn")
  const [reply, message] = turns
  assert.equal(words(reply), "Working through the feeds.")
  assert.deepEqual(
    kinds(message),
    ["text", "compaction"],
    "the divider still closes the message above it",
  )
  assert.equal(words(message), said, "said once")
})

test("the row it draws carries the id the chip is matched to", () => {
  // The screen that draws a chat is the one that has to keep the chip: the fold's turn carries the
  // routine row's id, and the message built from that turn names it (ADR 0081).
  const turns = foldTurns([
    row(1, "user", "check the feeds", { timestamp: 100 }),
    row(2, "assistant", "Working through the feeds.", { timestamp: 101, finish_reason: "stop" }),
    routine(3, "Morning watch: three new items.", { timestamp: 102 }),
  ])
  const drawn = messagesOf("chat", turns)
  assert.equal(drawn.length, 3, "the request, the reply, and the routine's own message")
  assert.deepEqual(
    drawn.map((one) => [one.role, one.routine === true, one.hermesRowId]),
    [
      ["user", false, undefined],
      ["assistant", false, undefined],
      ["assistant", true, 3],
    ],
    "only the routine's message is marked, and it names its row",
  )
  assert.equal(drawn[2].status, "done", "and it reads as finished, not as one still streaming")
})
