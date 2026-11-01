/**
 * Compaction as Hermes 0.22.5 leaves it in a transcript. The fixtures are the rows of a real
 * session that compacted while a request was being worked, read twice (as the host answers them
 * and with `include_compacted=true`); what was said is replaced, the structure is the host's own.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { foldTurns, withArchive, withCarried } from "../src/chat-next/fold.ts"
import { recorded } from "./chat-next-fixtures.ts"

const live = recorded("compaction.live.json").data
const archive = recorded("compaction.archive.json").data

const row = (id, role, content, extra = {}) => ({ id, role, content, ...extra })
const hidden = (id) => row(id, "user", "", { display_kind: "hidden" })
const kinds = (turn) => turn.parts.map((part) => part.kind)

test("the host's read opens on the compaction's hidden row: a turn whose request was archived, with no bubble of its own", () => {
  const [first] = foldTurns(live)
  assert.equal(first.carried, true)
  assert.equal(first.user, "")
  assert.deepEqual(
    kinds(first),
    ["text", "tools", "text", "tools", "text"],
    "the work it carried, drawn as the reply it was",
  )
  assert.equal(first.done, true, "its last row is a reply that says why it stopped")
})

test("the divider stands above the first row the host wrote after the compaction, not where the summary sits", () => {
  const turns = foldTurns(live)
  const at = turns.findIndex((turn) => turn.parts.some((part) => part.kind === "compaction"))
  assert.equal(turns[at].user, "User message 2.", "the reply the host wrote before the boundary")
  assert.equal(turns[at].parts.at(-1).kind, "compaction", "the divider closes it")
  assert.equal(turns[at + 1].user, "User message 3.", "and the first message after it follows")
})

test("the work a compaction carried sits above its divider, and what the run did after it below", () => {
  const [turn] = foldTurns([
    row(1, "user", "", { display_kind: "hidden", timestamp: 500 }),
    row(2, "assistant", "", {
      finish_reason: "tool_calls",
      timestamp: 100,
      tool_calls: [{ id: "c1", function: { name: "terminal", arguments: "{}" } }],
    }),
    row(3, "tool", "first", { tool_call_id: "c1", timestamp: 101 }),
    row(4, "assistant", "", {
      finish_reason: "tool_calls",
      timestamp: 600,
      tool_calls: [{ id: "c2", function: { name: "terminal", arguments: "{}" } }],
    }),
    row(5, "tool", "second", { tool_call_id: "c2", timestamp: 601 }),
    row(6, "assistant", "done", { finish_reason: "stop", timestamp: 700 }),
  ])
  assert.deepEqual(kinds(turn), ["tools", "compaction", "tools", "text"])
})

const call = (id) => ({ id, name: "terminal" })

test("a reply that compacts while it streams keeps its divider where it fell", () => {
  const copy = {
    user: "go",
    done: false,
    delivered: [],
    parts: [
      { kind: "tools", calls: [call("c1")] },
      { kind: "compaction", row: 9, at: 5 },
      { kind: "tools", calls: [call("c2")] },
    ],
  }
  const streamed = {
    user: "go",
    done: false,
    delivered: [],
    parts: [{ kind: "tools", calls: [call("c1"), call("c2")] }],
  }
  const kept = withCarried(streamed, copy)
  assert.deepEqual(
    kinds(kept),
    ["tools", "compaction", "tools"],
    "a group of calls is split at the seam",
  )
  assert.equal(kept.parts[0].calls.length, 1, "the call made before the boundary is above it")
})

test("two compactions with words between them keep both dividers, in the order they fell", () => {
  const copy = {
    user: "go",
    done: false,
    delivered: [],
    parts: [
      { kind: "tools", calls: [call("c1")] },
      { kind: "compaction", row: 8, at: 5 },
      { kind: "text", text: "Between." },
      { kind: "compaction", row: 9, at: 6 },
      { kind: "tools", calls: [call("c2")] },
    ],
  }
  const streamed = {
    user: "go",
    done: false,
    delivered: [],
    parts: [
      { kind: "tools", calls: [call("c1")] },
      { kind: "text", text: "Between." },
      { kind: "tools", calls: [call("c2")] },
    ],
  }
  assert.deepEqual(kinds(withCarried(streamed, copy)), [
    "tools",
    "compaction",
    "text",
    "compaction",
    "tools",
  ])
})

test("a seam below the reply's words stays below them, and one above its first word stays there", () => {
  const words = {
    user: "go",
    done: false,
    delivered: [],
    parts: [{ kind: "text", text: "Thinking aloud." }],
  }
  const spoken = {
    ...words,
    parts: [
      { kind: "text", text: "Thinking aloud." },
      { kind: "compaction", row: 9, at: 5 },
      { kind: "tools", calls: [call("c1")] },
    ],
  }
  assert.deepEqual(
    kinds(withCarried(words, spoken)),
    ["text", "compaction"],
    "the words it fell after are drawn above the line",
  )
  const carried = {
    user: "",
    done: false,
    delivered: [],
    parts: [
      { kind: "compaction", row: 9, at: 5 },
      { kind: "text", text: "Carried work." },
    ],
  }
  const live = {
    user: "",
    done: false,
    delivered: [],
    parts: [{ kind: "text", text: "Carried work." }],
  }
  assert.deepEqual(
    kinds(withCarried(live, carried)),
    ["compaction", "text"],
    "nothing was drawn above it, so the line opens the reply",
  )
})

test("the rows the host wrote for the host's own sake are never a message of the user's", () => {
  const turns = foldTurns(live)
  assert.ok(turns.every((turn) => !turn.user.startsWith("[System:")))
  assert.ok(turns.slice(1).every((turn) => turn.user !== ""))
  // The user's own words after the compaction are turns as before.
  assert.equal(turns[1].user, "User message 1.")
})

test("the task snapshot and the pruned-skills notice Hermes writes at the seam are never drawn as the user's", () => {
  const snapshot = [
    "[Your active task list was preserved across context compression]",
    "- [>] 4. Checkpoint 3: app (in_progress)",
    "- [ ] 6. Full suite (pending)",
    "",
    "[Skills pruned during compression — reload before acting on these tasks]",
    "The task list above crossed the compression boundary verbatim, but the skill instructions that governed it were pruned.",
  ].join("\n")
  const turns = foldTurns([
    row(1, "user", "one"),
    row(2, "assistant", "first", { finish_reason: "stop" }),
    row(3, "user", snapshot),
    row(4, "assistant", "second", { finish_reason: "stop" }),
    row(5, "user", `two\n\n${snapshot.split("\n\n")[0]}`),
    row(6, "assistant", "third", { finish_reason: "stop" }),
  ])
  assert.deepEqual(
    turns.map((turn) => turn.user),
    ["one", "two"],
  )
  assert.equal(
    turns[0].parts.length,
    2,
    "the reply after the notice stays on the turn it continues",
  )
})

test("a compaction between two replies stands between them", () => {
  const turns = foldTurns([
    row(1, "user", "one"),
    row(2, "assistant", "first", { finish_reason: "stop" }),
    hidden(3),
    row(4, "user", "two"),
    row(5, "assistant", "second", { finish_reason: "stop" }),
  ])
  assert.equal(turns.length, 2)
  assert.deepEqual(kinds(turns[0]), ["text", "compaction"])
  assert.equal(turns[0].done, true)
  assert.deepEqual(kinds(turns[1]), ["text"])
  assert.equal(turns[1].carried, undefined)
})

test("a compaction in the middle of a reply keeps the reply whole around it", () => {
  const [turn] = foldTurns([
    row(1, "user", "go"),
    row(2, "assistant", "starting", { finish_reason: "tool_calls" }),
    hidden(3),
    row(4, "assistant", "finished", { finish_reason: "stop" }),
  ])
  assert.deepEqual(kinds(turn), ["text", "compaction", "text"])
  assert.equal(turn.done, true)
})

test("rows that hold a compaction twice over draw it once", () => {
  const [turn] = foldTurns([
    row(1, "user", "go"),
    row(2, "assistant", "a", { finish_reason: "tool_calls" }),
    hidden(3),
    hidden(4),
    row(5, "assistant", "b", { finish_reason: "stop" }),
  ])
  assert.deepEqual(kinds(turn), ["text", "compaction", "text"])
})

test("a compaction with nothing after it leaves the thread finished, not waiting on a reply", () => {
  const turns = foldTurns([hidden(1)])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].done, true)
  assert.deepEqual(kinds(turns[0]), ["compaction"])
})

test("a work call that opens the carried turn keeps its result", () => {
  const [first] = foldTurns([
    hidden(1),
    row(2, "assistant", "", {
      finish_reason: "tool_calls",
      tool_calls: [{ id: "c1", function: { name: "terminal", arguments: "{}" } }],
    }),
    row(3, "tool", "output", { tool_call_id: "c1" }),
  ])
  assert.equal(first.done, false, "the host has not written its last reply")
  const tools = first.parts.find((part) => part.kind === "tools")
  assert.equal(tools.calls[0].result, "output")
})

test("the archive adds only the rows the live read does not hold, above it, in the order the host gave them", () => {
  const merged = withArchive(live, archive)
  const liveIds = new Set(live.map((one) => one.id))
  const added = merged.slice(0, merged.length - live.length)
  assert.ok(added.length > 0)
  assert.ok(added.every((one) => !liveIds.has(one.id)))
  assert.deepEqual(
    added.map((one) => one.id),
    archive.filter((one) => !liveIds.has(one.id)).map((one) => one.id),
  )
  assert.deepEqual(merged.slice(added.length), live)
})

test("with the archive, the turn the compaction cut in two is whole again, under its own request", () => {
  const turns = foldTurns(withArchive(live, archive))
  assert.equal(turns[0].user, "First request, before the context was compacted.")
  assert.equal(turns[0].parts[0].text, "First reply, before the context was compacted.")
  const request = turns[1]
  assert.equal(request.user, "Request that was still being worked when the context was compacted.")
  assert.equal(request.carried, undefined, "it has its request again")
  assert.deepEqual(
    kinds(request),
    ["compaction", "text", "tools", "text", "tools", "text"],
    "the archive and the live rows hold one boundary here, and it draws one line",
  )
  assert.equal(turns.filter((turn) => turn.carried).length, 0)
})

test("an archive read that adds nothing leaves the transcript as it was", () => {
  assert.deepEqual(withArchive(live, live), live)
})
