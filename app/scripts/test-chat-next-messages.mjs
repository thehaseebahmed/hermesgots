import assert from "node:assert/strict"
import test from "node:test"

import { foldTurns } from "../src/chat-next/fold.ts"
import { heldMessage, messagesOf } from "../src/chat-next/messages.ts"
import { retryText } from "../src/lib/retry-message.ts"
import { attachmentsText } from "../src/lib/attachment-text.ts"
import { NOT_SENT } from "../src/lib/words.ts"
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

test("a call without its result runs while the host still works the turn", () => {
  // A phone that opens a chat whose run waits on a question streams nothing here: the call the host
  // has not answered is still running, so the thread says it waits rather than that it was missed.
  const rows = [
    row(1, "user", "go"),
    row(2, "assistant", "", { tool_calls: [call("a", "clarify", { question: "Tea?" })] }),
  ]
  const [, inFlight] = messagesOf("chat", foldTurns(rows), { inFlight: true })
  assert.equal(inFlight.tools[0].status, "running")
  assert.equal(inFlight.status, "done", "the reply is not drawn as streaming here")

  // A host that says it works nothing leaves the call one that ended with no result.
  const [, atRest] = messagesOf("chat", foldTurns(rows))
  assert.equal(atRest.tools[0].status, "completed")
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
  const files = [
    { id: "a", name: "a.png", type: "image/png", size: 3, image: true, path: "/h/a.png" },
  ]
  const rows = [row(1, "user", attachmentsText("Look", files))]
  const [user] = messagesOf("chat", foldTurns(rows))
  assert.equal(user.content, "Look")
  assert.equal(user.attachments[0].name, "a.png")
  assert.equal(user.attachments[0].path, "/h/a.png")
})

test("a steer sits where it was sent, and a wake turn draws no request", () => {
  const rows = [
    row(1, "user", "go", { timestamp: 100 }),
    row(2, "assistant", "Working.", {
      timestamp: 101,
      tool_calls: [call("a", "terminal", { command: "ls" })],
    }),
    row(3, "tool", "ok", { timestamp: 102, tool_call_id: "a" }),
    row(4, "user", "also this", { timestamp: 103, display_kind: "steer" }),
    row(5, "assistant", "Done.", { timestamp: 104, finish_reason: "stop" }),
    row(6, "user", "[ASYNC DELEGATION COMPLETE — child-1]\nresult", { timestamp: 200 }),
    row(7, "assistant", "The child finished.", { timestamp: 201, finish_reason: "stop" }),
  ]
  const drawn = messagesOf("chat", foldTurns(rows))
  assert.deepEqual(
    drawn.map((one) => one.role),
    ["user", "assistant", "assistant"],
  )
  assert.deepEqual(
    drawn[1].steers.map(({ text, contentOffset }) => [text, contentOffset]),
    [["also this", "Working.".length]],
  )
  assert.equal(
    drawn[2].createdAt,
    200_000,
    "the wake run's answer is drawn at the delivery that woke it, not at the epoch",
  )
})

test("a steer the run read between two calls keeps its place among them", () => {
  const rows = [
    row(1, "user", "go"),
    row(2, "assistant", "Working.", { tool_calls: [call("a", "terminal", { command: "ls" })] }),
    row(3, "tool", "ok", { tool_call_id: "a" }),
    row(4, "user", "also this", { display_kind: "steer" }),
    row(5, "assistant", "", { tool_calls: [call("b", "terminal", { command: "pwd" })] }),
    row(6, "tool", "/app", { tool_call_id: "b" }),
    row(7, "assistant", "Done.", { finish_reason: "stop" }),
  ]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  // Both calls share the offset the steer landed at, so only the count can place it among them.
  assert.deepEqual(
    reply.steers.map(({ text, contentOffset, toolsBefore }) => [text, contentOffset, toolsBefore]),
    [["also this", "Working.".length, 1]],
  )
  assert.deepEqual(
    reply.tools.map((tool) => [tool.label, tool.contentOffset]),
    [
      ["ls", "Working.".length],
      ["pwd", "Working.".length],
    ],
  )
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

test("a row's thinking leads the call or the words it came with, and follows the call before it", () => {
  const rows = [
    row(1, "user", "go"),
    row(2, "assistant", "", {
      reasoning: "Look first.",
      tool_calls: [call("a", "terminal", { command: "ls" })],
    }),
    row(3, "tool", "files", { tool_call_id: "a" }),
    row(4, "assistant", "All done.", { reasoning: "Now say so.", finish_reason: "stop" }),
  ]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  assert.deepEqual(reply.reasoningRuns, [
    { text: "Look first." },
    { text: "Now say so.", afterToolId: "a" },
  ])
  assert.equal(reply.content, "All done.")
})

test("thinking with no words or calls after it still draws as a reply", () => {
  const rows = [row(1, "user", "go"), row(2, "assistant", "", { reasoning: "Hmm." })]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  assert.deepEqual(reply.reasoningRuns, [{ text: "Hmm." }])
})

test("a live turn's unplaced thinking draws as the run still to come", () => {
  const turn = { user: "go", parts: [], done: false, delivered: [], pendingThought: "Hmm." }
  const [, reply] = messagesOf("chat", [turn], { streaming: true })
  assert.deepEqual(reply.reasoningRuns, [{ text: "Hmm." }])
})

test("a tool row whose result is a parts list draws as a completed call", () => {
  const rows = [
    row(1, "user", "snap it"),
    row(2, "assistant", "", { tool_calls: [call("a", "terminal", { command: "true" })] }),
    row(
      3,
      "tool",
      [
        { type: "text", text: '{"exit_code": 0}' },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
      { tool_call_id: "a" },
    ),
    row(4, "assistant", "Snapped.", { finish_reason: "stop" }),
  ]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  const [tool] = reply.tools
  assert.equal(tool.result, '{"exit_code": 0}', "the row holds the JSON its text part carries")
  assert.equal(tool.status, "completed")
  assert.equal(tool.error, undefined, "a call that exited zero failed at nothing")
})

test("a tool row whose result leads with an image still draws as the failed call it was", () => {
  const rows = [
    row(1, "user", "snap it"),
    row(2, "assistant", "", { tool_calls: [call("a", "terminal", { command: "false" })] }),
    row(
      3,
      "tool",
      [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: '{"exit_code": 1}' },
      ],
      { tool_call_id: "a" },
    ),
    row(4, "assistant", "It went wrong.", { finish_reason: "stop" }),
  ]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  const [tool] = reply.tools
  assert.equal(tool.status, "failed", "the exit code the result holds is what the row says")
  assert.equal(tool.error, "Exit code 1")
})

test("a tool row whose result is one structured dict draws as a completed call", () => {
  const rows = [
    row(1, "user", "say hi"),
    row(2, "assistant", "", { tool_calls: [call("a", "terminal", { command: "echo hi" })] }),
    row(3, "tool", { text: '{"output": "hi", "exit_code": 0}' }, { tool_call_id: "a" }),
    row(4, "assistant", "Said it.", { finish_reason: "stop" }),
  ]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  const [tool] = reply.tools
  assert.equal(tool.result, '{"output": "hi", "exit_code": 0}', "the row holds the dict's own words")
  assert.equal(tool.status, "completed")
  assert.equal(tool.error, undefined)
})

test("a user row whose content is a parts list draws the words it typed", () => {
  const rows = [
    row(1, "user", [
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]),
    row(2, "assistant", "A cat.", { finish_reason: "stop" }),
  ]
  const [user] = messagesOf("chat", foldTurns(rows))
  assert.match(user.content, /look at this/)
  assert.match(user.content, /\[image\]/)
})

test("an assistant row whose content is a parts list draws its text", () => {
  const rows = [
    row(1, "user", "show me"),
    row(
      2,
      "assistant",
      [
        { type: "text", text: "Here it is." },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
      { finish_reason: "stop" },
    ),
  ]
  const [, reply] = messagesOf("chat", foldTurns(rows))
  assert.match(reply.content, /Here it is\./)
})

test("a not-sent retry draws its words alone: no retry marker, no attachment marker", () => {
  const file = { name: "sky.jpg", type: "image/jpeg", size: 2048, image: true, path: "/h/sky.jpg" }
  const text = retryText(attachmentsText("Look around", [file]))
  const held = heldMessage("chat", { id: "u1", text, attachments: [file], at: 1 })
  assert.equal(held.content, "Look around", "the words, and neither set of markers")
  assert.equal(held.statusText, NOT_SENT)
  assert.equal(held.attachments.length, 1, "the file is still the message's own")
})
