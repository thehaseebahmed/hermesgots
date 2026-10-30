/**
 * The progress reminder's own refusal, as a thread reads it: the note Gots writes to the model lands
 * in the transcript as the result of the call it turned back, and no thread draws a card of it —
 * both folds, the live draft's own and the settled transcript's, show the call the model made again
 * instead (ADR 0068). A refusal any other hook made is a thing the reader should still see.
 *
 * The component tier because the shipped chat's fold (`lib/history.ts`) reaches the app through its
 * `@/…` aliases, which is the loader that test file gets.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { foldTurns } from "@/chat-next/fold"
import { toMessages } from "@/lib/history"
import { isProgressReminder, refusedCallIds } from "@/lib/progress-reminder"

/** A note shaped as `progress.py` writes it: one line, the pinned opening, then the ask. */
const NOTE =
  "Progress reminder: a long run of tool calls with nothing said to the user. Reply with a short" +
  " update now — what has landed and what is next, a sentence or two, not a replay of the calls —" +
  " and, where the plan has moved, bring your todo list up to date with todo_list. Then make this" +
  " tool call again. This note is internal: don't mention it, or that you were reminded, in what you" +
  " say to the user."

/** The result Hermes stores for a call a hook blocked: the note under `error`. */
const stored = (note: string) => JSON.stringify({ error: note })

const UPDATE = "Halfway: the parser reads end to end, and the tests come next."

/**
 * A turn the reminder interrupted: one call refused, the update it asked for, and the same call
 * made again. `refusal` is what the refused call's result carries, so a test can swap in another
 * hook's own words.
 */
const interrupted = (refusal: string = stored(NOTE)) => [
  { id: 1, role: "user", content: "Read the parser", timestamp: 1 },
  {
    id: 2,
    role: "assistant",
    content: null,
    timestamp: 2,
    tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
  },
  { id: 3, role: "tool", content: refusal, tool_call_id: "call-1", timestamp: 3 },
  {
    id: 4,
    role: "assistant",
    content: UPDATE,
    timestamp: 4,
    tool_calls: [{ id: "call-2", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
  },
  { id: 5, role: "tool", content: "export const a = 1", tool_call_id: "call-2", timestamp: 5 },
]

test("the note is recognised in both shapes a result arrives in, and nothing else is", () => {
  assert.equal(isProgressReminder(stored(NOTE)), true, "the transcript's JSON envelope")
  assert.equal(isProgressReminder(NOTE), true, "the note itself, as a stream may preview it")
  assert.equal(isProgressReminder(`  ${stored(NOTE)}\n`), true, "either, with the whitespace gone")
  assert.equal(
    isProgressReminder(stored("Blocked: this writes outside the worktree")),
    false,
    "another hook's refusal is not this one",
  )
  assert.equal(isProgressReminder("export const a = 1"), false, "a call's own output")
  assert.equal(isProgressReminder(null), false, "a row with no content")
  assert.equal(isProgressReminder("{not json"), false, "a result that isn't the envelope")
})

test("the refused call's id is the one its result answers", () => {
  const rows = interrupted()
  assert.deepEqual([...refusedCallIds(rows)], ["call-1"])
  assert.deepEqual([...refusedCallIds(interrupted(stored("Blocked: no")))], [])
})

test("the thread draws the call that ran, not the one the reminder refused", () => {
  const [request, reply] = toMessages("c-1", "s-1", interrupted())
  assert.equal(request.role, "user")
  assert.deepEqual(
    reply.tools?.map((tool) => tool.toolCallId),
    ["call-2"],
    "the refused call's card is gone, and the repeat is the one card left",
  )
  assert.match(reply.content, /Halfway: the parser reads end to end/, "the update it asked for stays")
})

test("the chat-next fold drops the refused call too", () => {
  const [turn] = foldTurns(interrupted())
  const calls = turn.parts.flatMap((part) => (part.kind === "tools" ? part.calls : []))
  assert.deepEqual(
    calls.map((call) => call.id),
    ["call-2"],
  )
  const text = turn.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
  assert.match(text.join("\n"), /Halfway: the parser reads end to end/)
})

test("a refusal any other hook made is still drawn", () => {
  const [request, reply] = toMessages("c-1", "s-1", interrupted(stored("Blocked: no such path")))
  assert.equal(request.role, "user")
  assert.deepEqual(
    reply.tools?.map((tool) => tool.toolCallId),
    ["call-1", "call-2"],
    "a security hook's block is a thing the reader should read",
  )
  assert.equal(reply.tools?.[0]?.status, "failed")
})
