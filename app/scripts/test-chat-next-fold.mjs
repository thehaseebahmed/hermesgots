import assert from "node:assert/strict"
import test from "node:test"

import { foldTurns } from "../src/chat-next/fold.ts"
import { attachmentsText, marker } from "../src/lib/attachment-text.ts"
import { durableUserRow } from "./host-row.mjs"
import { recorded } from "./chat-next-fixtures.ts"

const fixture = recorded("sky-blue.transcript.json")

// A real 1x1 PNG, so the fake host commits bytes the way the host's own sniffing accepts them.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=="

const row = (id, role, content, extra = {}) => ({ id, role, content, ...extra })

test("one request and the fourteen rows the host wrote for it fold into a single turn", () => {
  const turns = foldTurns(fixture.data)
  assert.equal(turns.length, 1)
  assert.match(turns[0].user, /^Do these steps in order/)
})

test("a turn's reply keeps its words and its calls in the order the host wrote them", () => {
  const [turn] = foldTurns(fixture.data)
  assert.deepEqual(
    turn.parts.map((part) => part.kind),
    ["text", "tools", "text"],
  )
  assert.equal(turn.parts[0].text, "I'll work through these in order.")
  assert.match(turn.parts[2].text, /^All six steps are done/)
  assert.match(turn.parts[2].text, /# Why the Sky Is Blue/)
})

test("every call joins the one run of calls and takes its result from the row that answers it", () => {
  const [turn] = foldTurns(fixture.data)
  const calls = turn.parts[1].calls
  assert.equal(calls.length, 8)
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "todo_list",
      "todo_list",
      "terminal",
      "read_file",
      "terminal",
      "todo_list",
      "todo_list",
      "todo_list",
    ],
  )
  assert.ok(
    calls.every((call) => typeof call.result === "string"),
    "each call has its result",
  )
  assert.match(calls[2].result, /hello from fixture/)
})

test("an assistant row with no words draws no text of its own", () => {
  const turns = foldTurns([
    row(1, "user", "go"),
    row(2, "assistant", "", {
      tool_calls: [{ id: "a", type: "function", function: { name: "terminal", arguments: "{}" } }],
    }),
    row(3, "tool", "{}", { tool_call_id: "a", tool_name: "terminal" }),
    row(4, "assistant", "done"),
  ])
  assert.deepEqual(
    turns[0].parts.map((part) => part.kind),
    ["tools", "text"],
  )
})

test("each user row starts the next turn", () => {
  const turns = foldTurns([
    row(1, "user", "one"),
    row(2, "assistant", "first"),
    row(3, "user", "two"),
    row(4, "assistant", "second"),
  ])
  assert.deepEqual(
    turns.map((turn) => [turn.user, turn.parts[0].text]),
    [
      ["one", "first"],
      ["two", "second"],
    ],
  )
})

// The states recorded from a real host while a run was going (session memento-fixture-events-2).
test("a turn is done only when its last row is an assistant row that made no call and says why it stopped", () => {
  const user = row(1, "user", "go")
  const calling = row(2, "assistant", "", {
    finish_reason: "tool_calls",
    tool_calls: [{ id: "a", type: "function", function: { name: "terminal", arguments: "{}" } }],
  })
  const result = row(3, "tool", "{}", { tool_call_id: "a", tool_name: "terminal" })
  const stop = row(4, "assistant", "done", { finish_reason: "stop" })
  const done = (...rows) => foldTurns(rows)[0].done
  assert.equal(done(user), false, "only the request written")
  assert.equal(done(user, calling), false, "a call made, no result yet")
  assert.equal(done(user, calling, result), false, "a result in, no reply yet")
  assert.equal(done(user, calling, result, stop), true, "the reply is written")
  assert.equal(foldTurns(fixture.data)[0].done, true, "the recorded session's one turn")
})

test("a turn recorded from v0.22.5 folds the same way: four calls with their results, then the reply", () => {
  const [turn] = foldTurns(recorded("multi-reader.transcript.json").data)
  assert.equal(turn.done, true)
  const calls = turn.parts.flatMap((part) => (part.kind === "tools" ? part.calls : []))
  assert.equal(calls.length, 4)
  assert.ok(
    calls.every((call) => typeof call.result === "string"),
    "each call has its result",
  )
  assert.equal(turn.parts.at(-1).kind, "text", "the turn ends on its reply")
})

test("a request's attachment markers are its files, not its words", () => {
  const photo = {
    id: "a",
    name: "sky.jpg",
    type: "image/jpeg",
    size: 2048,
    image: true,
    path: "/h/sky.jpg",
  }
  const notes = { id: "b", name: "notes.md", type: "text/markdown", size: 512, path: "/h/notes.md" }
  // Written the way every send writes it, then kept by the host as the request's own row.
  const content = attachmentsText("What's in these?", [photo, notes])
  const [turn] = foldTurns([
    row(1, "user", content),
    row(2, "assistant", "A sky and a list.", { finish_reason: "stop" }),
  ])
  assert.equal(turn.user, "What's in these?")
  assert.deepEqual(turn.files, [
    { name: "sky.jpg", type: "image/jpeg", size: 2048, image: true, path: "/h/sky.jpg" },
    { name: "notes.md", type: "text/markdown", size: 512, image: false, path: "/h/notes.md" },
  ])
})

test("a request the host committed a photo for folds the same as it was sent", () => {
  const photo = { id: "a", name: "sky.jpg", type: "image/jpeg", size: 2048, image: true, path: "/h/sky.jpg" }
  const content = durableUserRow([
    { type: "text", text: "What's in these?" },
    { type: "text", text: marker(photo) },
    { type: "image_url", image_url: { url: PNG } },
  ])
  assert.match(content, /^What's in these\?\n\n\[Image attached at: /, "the hint lands with the words")
  const [turn] = foldTurns([
    row(1, "user", content),
    row(2, "assistant", "A sky.", { finish_reason: "stop" }),
  ])
  assert.equal(turn.user, "What's in these?")
  assert.deepEqual(turn.files, [
    { name: "sky.jpg", type: "image/jpeg", size: 2048, image: true, path: "/h/sky.jpg" },
  ])
})

test("a photo the host's row named folds with the flag that keeps it off the wire", () => {
  const content = ["look", "", "[Image attached at: /c/native-inputs/abc/api_abc.jpg]", "[screenshot]"].join(
    "\n",
  )
  const [turn] = foldTurns([row(1, "user", content), row(2, "assistant", "A sky.", { finish_reason: "stop" })])
  assert.equal(turn.user, "look")
  assert.equal(turn.files[0].host, true, "the retry path can still tell it was never the user's file")
})

test("a request with no attachments carries no files", () => {
  const [turn] = foldTurns([row(1, "user", "Just words.")])
  assert.equal(turn.files, undefined)
})

test("a steer goes on the reply it steered, without the marker Hermes wraps it in", () => {
  const turns = foldTurns([
    row(1, "user", "Write a poem"),
    row(2, "assistant", "", {
      tool_calls: [{ id: "c1", function: { name: "terminal", arguments: "{}" } }],
    }),
    row(3, "tool", "{}", { tool_call_id: "c1" }),
    row(
      4,
      "user",
      "[OUT-OF-BAND USER MESSAGE — sent while you worked]\nMake it rhyme\n[/OUT-OF-BAND USER MESSAGE]",
      {
        display_kind: "steer",
      },
    ),
    row(5, "assistant", "Roses are red.", { finish_reason: "stop" }),
  ])
  assert.equal(turns.length, 1, "a steer opens no turn")
  assert.deepEqual(
    turns[0].parts.map((part) => part.kind),
    ["tools", "steer", "text"],
  )
  assert.equal(turns[0].parts[1].text, "Make it rhyme")
})

test("a steer's file is not its words", () => {
  const file = { id: "f", name: "notes.md", type: "text/markdown", size: 40, image: false, path: "/h/notes.md" }
  const turns = foldTurns([
    row(1, "user", "Write a poem"),
    row(2, "assistant", "Here it comes.", { finish_reason: "stop" }),
    row(3, "user", attachmentsText("Make it rhyme", [file]), { display_kind: "steer" }),
  ])
  const steered = turns[0].parts.find((part) => part.kind === "steer")
  assert.equal(steered.text, "Make it rhyme")
})

test("a failed turn's row ends the turn and keeps the host's words, not as a reply", () => {
  const turns = foldTurns([
    row(1, "user", "Connect my office"),
    row(2, "assistant", "Your request was not processed.", { display_kind: "failed_turn" }),
    row(3, "user", "Something else"),
    row(4, "assistant", "Your request was not processed.", { display_kind: "failed_turn" }),
  ])
  assert.deepEqual(
    turns.map((turn) => [turn.done, turn.failed?.text, turn.failed?.row, turn.parts.length]),
    [
      [true, "Your request was not processed.", 2, 0],
      [true, "Your request was not processed.", 4, 0],
    ],
  )
})

test("a failed turn the next turn asks again is behind the user, whatever the chain", () => {
  const failed = (id) => row(id, "assistant", "no", { display_kind: "failed_turn" })
  const turns = foldTurns([
    row(1, "user", "Connect my office"),
    failed(2),
    row(3, "user", "Connect my office"),
    failed(4),
    row(5, "user", "Connect my office"),
    row(6, "assistant", "Here is how.", { finish_reason: "stop" }),
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].failed, undefined)
  assert.equal(turns[0].parts[0].text, "Here is how.")
})
