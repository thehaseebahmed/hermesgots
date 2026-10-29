import assert from "node:assert/strict"
import test from "node:test"

import { foldTurns } from "../src/chat-next/fold.ts"
import { messagesOf } from "../src/chat-next/messages.ts"
import { attachmentsText } from "../src/lib/attachment-text.ts"
import { recorded } from "./chat-next-fixtures.ts"

const fixture = recorded("sky-blue.transcript.json")

const row = (id, role, content, extra = {}) => ({ id, role, content, ...extra })
const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } })

test("a turn draws as the user's request and one reply, its calls placed where they were made", () => {
  const rows = messagesOf("chat", foldTurns(fixture.data))
  assert.deepEqual(
    rows.map((one) => one.role),
    ["user", "assistant"],
  )
  const [user, reply] = rows
  assert.match(user.content, /^Do these steps in order/)
  assert.match(reply.content, /^I'll work through these in order\.\n\n/)
  assert.ok(reply.tools.length > 0)
  const first = "I'll work through these in order.".length
  assert.ok(reply.tools.every((tool) => tool.contentOffset === first))
  assert.ok(reply.tools.every((tool) => tool.status !== "running"))
})

test("a row's id is its turn's place, so a later read keeps every id the earlier one drew", () => {
  const earlier = messagesOf("chat", foldTurns(fixture.data.slice(0, 3)), { streaming: true })
  const later = messagesOf("chat", foldTurns(fixture.data))
  assert.deepEqual(
    earlier.map((one) => one.id),
    later.map((one) => one.id),
  )
})

test("a call is named and timed as the transcript wrote it, and a failed one says why", () => {
  const rows = [
    row(1, "user", "check", { timestamp: 100 }),
    row(2, "assistant", "", {
      timestamp: 101,
      tool_calls: [call("a", "terminal", { command: "false" })],
    }),
    row(3, "tool", JSON.stringify({ output: "", exit_code: 1 }), {
      tool_call_id: "a",
      timestamp: 104,
    }),
    row(4, "assistant", "It failed.", { timestamp: 105, finish_reason: "stop" }),
  ]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  const [tool] = reply.tools
  assert.equal(tool.label, "false")
  assert.equal(tool.status, "failed")
  assert.ok(tool.error)
  assert.equal(tool.endedAt - tool.startedAt, 3000)
  assert.equal(reply.createdAt, 100_000)
})

test("a call without its result runs only while the turn streams here", () => {
  const rows = [
    row(1, "user", "go"),
    row(2, "assistant", "", { tool_calls: [call("a", "terminal", { command: "sleep 9" })] }),
  ]
  const [, streaming] = messagesOf("chat", foldTurns(rows), { streaming: true })
  assert.equal(streaming.status, "streaming")
  assert.equal(streaming.tools[0].status, "running")
  const [, settled] = messagesOf("chat", foldTurns(rows))
  assert.equal(settled.status, "done")
  assert.equal(settled.tools[0].status, "completed")
})

test("a reply not begun still draws while it streams, so the thread shows it working", () => {
  const rows = messagesOf("chat", [{ user: "hi", parts: [], done: false, delivered: [] }], {
    streaming: true,
  })
  assert.deepEqual(
    rows.map((one) => [one.role, one.status]),
    [
      ["user", "done"],
      ["assistant", "streaming"],
    ],
  )
})

test("a request's files are its attachments, and its marker lines are not its words", () => {
  const files = [{ id: "a", name: "a.png", type: "image/png", size: 3, image: true, path: "/h/a.png" }]
  const rows = [row(1, "user", attachmentsText("Look", files))]
  const [user] = messagesOf("chat", foldTurns(rows))
  assert.equal(user.content, "Look")
  assert.equal(user.attachments[0].name, "a.png")
  assert.equal(user.attachments[0].path, "/h/a.png")
})

test("a steer sits where it was sent, and a wake turn draws no request", () => {
  const rows = [
    row(1, "user", "go"),
    row(2, "assistant", "Working.", { tool_calls: [call("a", "terminal", { command: "ls" })] }),
    row(3, "tool", "ok", { tool_call_id: "a" }),
    row(4, "user", "also this", { display_kind: "steer" }),
    row(5, "assistant", "Done.", { finish_reason: "stop" }),
    row(6, "user", "[ASYNC DELEGATION COMPLETE — child-1]\nresult"),
    row(7, "assistant", "The child finished.", { finish_reason: "stop" }),
  ]
  const drawn = messagesOf("chat", foldTurns(rows))
  assert.deepEqual(
    drawn.map((one) => one.role),
    ["user", "assistant", "assistant"],
  )
  assert.deepEqual(drawn[1].steers.map(({ text, contentOffset }) => [text, contentOffset]), [
    ["also this", "Working.".length],
  ])
})

test("a compaction inside a reply is a seam naming the summary's row", () => {
  const rows = [
    row(1, "user", "go"),
    row(2, "assistant", "Before."),
    row(3, "user", "", { display_kind: "hidden", timestamp: 50 }),
    row(4, "assistant", "After.", { finish_reason: "stop" }),
  ]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  assert.deepEqual(
    reply.seams.map(({ row, contentOffset, at }) => [row, contentOffset, at]),
    [[3, "Before.".length, 50_000]],
  )
})
