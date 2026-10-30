import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { foldTurns } from "../src/chat-next/fold.ts"
import {
  isProgressReminder,
  PROGRESS_REMINDER_HEADER,
  refusedCallIds,
} from "../src/lib/progress-reminder.ts"
import { NOTE, stored } from "./progress-reminder-fixture.ts"

const PLUGIN = readFileSync(new URL("../../plugin/progress.py", import.meta.url), "utf8")
const PINNED = /^REMINDER_HEADER = "([^"]+)"$/m.exec(PLUGIN)?.[1]

const UPDATE = "Halfway: the parser reads end to end, and the tests come next."

const interrupted = (refusal = stored(NOTE)) => [
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

test("the app matches the opening the plugin actually writes", () => {
  assert.equal(PINNED, "Progress reminder", "progress.py's own REMINDER_HEADER, as it stands")
  assert.equal(PROGRESS_REMINDER_HEADER, `${PINNED}:`, "and this app matches it, byte for byte")
})

test("the note reads through the envelope Hermes stores, whole or cut", () => {
  assert.equal(isProgressReminder(stored(NOTE)), true, "the row's `{\"error\": …}`")
  assert.equal(
    isProgressReminder(`  ${stored(NOTE)}\n`),
    true,
    "the same, with the whitespace a result may carry",
  )
  assert.equal(isProgressReminder(stored(NOTE).slice(0, 120)), true, "a preview cut part way")
  assert.equal(isProgressReminder(NOTE), false, "the note alone is not a result Hermes writes")
})

test("nothing else reads as one", () => {
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
  assert.deepEqual([...refusedCallIds(interrupted())], ["call-1"])
  assert.deepEqual([...refusedCallIds(interrupted(stored("Blocked: no")))], [])
})

test("the fold draws the call that ran, not the one the reminder refused", () => {
  const [turn] = foldTurns(interrupted())
  const calls = turn.parts.flatMap((part) => (part.kind === "tools" ? part.calls : []))
  assert.deepEqual(
    calls.map((call) => call.id),
    ["call-2"],
    "the refused card is gone and the repeat is the one left",
  )
  const text = turn.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
  assert.match(text.join("\n"), /Halfway: the parser reads end to end/)
})

test("a row whose only call was refused still made one, and the turn is not finished", () => {
  const [turn] = foldTurns([
    { id: 1, role: "user", content: "Read the parser", timestamp: 1 },
    {
      id: 2,
      role: "assistant",
      content: null,
      reasoning: "Checking the entry point first.",
      finish_reason: "tool_calls",
      timestamp: 2,
      tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
    },
    { id: 3, role: "tool", content: stored(NOTE), tool_call_id: "call-1", timestamp: 3 },
  ])
  assert.equal(turn.done, false, "the run is still working")
  assert.deepEqual(
    turn.parts.filter((part) => part.kind === "tools"),
    [],
    "and no card is drawn for the refusal",
  )
  const thought = turn.parts.map((part) => part.thought).find(Boolean)
  assert.match(thought ?? "", /Checking the entry point first/, "the thinking is kept")
})
