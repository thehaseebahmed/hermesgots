/**
 * A subagent's result is the bot's own message: the delivery row Hermes writes as a user row draws
 * with the result its subagent left, carrying the ids that name that subagent, and a transcript
 * written before deliveries existed reads exactly as it did.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { isSubagentResult, subagentMessage, subagentResults } from "../src/lib/subagent-results.ts"

const GOAL = "Review the parser for the reader"
const RESULT = "The parser reads a reply in parse.ts, then keeps its blocks."

/** The delivery row core writes: a `user` row whose display kind says it is a subagent's result. */
const delivery = (id, content) => ({
  id,
  role: "user",
  display_kind: "async_delegation_complete",
  content,
  timestamp: 1_700_000_000,
})

/** The `delegate_task` call's own result row, which a background turn leaves in the transcript. */
const dispatched = (id, payload) => ({
  id,
  role: "tool",
  tool_call_id: `call-${id}`,
  content: JSON.stringify({ status: "dispatched", mode: "background", ...payload }),
  timestamp: 1_699_999_000,
})

const SINGLE = [
  "[ASYNC DELEGATION COMPLETE — d-1]",
  "A background subagent you dispatched earlier has finished. You may have moved on since dispatching",
  "it; the full task source is below so you can act on the result or re-dispatch if things have",
  "changed.",
  "",
  "Dispatched: 2026-10-23 10:00:00 (2 min ago)",
  `Original goal: ${GOAL}`,
  "Role: leaf   Model: claude-opus-5-5",
  "Status: completed   API calls: 12   Duration: 96.4s",
  "--- RESULT ---",
  RESULT,
].join("\n")

const BATCH = [
  "[ASYNC DELEGATION BATCH COMPLETE — d-3-2]",
  "A background fan-out unit you dispatched earlier — group 'b' (1 subagent(s)) — has finished.",
  "",
  "Dispatched: 2026-10-23 10:05:00 (1 min ago)",
  "Role: leaf   Model: claude-opus-5-5   Total duration: 30s",
  "",
  "--- ✓ TASK 2/3: Audit the docs  (status=completed, api_calls=4, 20s) ---",
  "The docs name every rule the parser follows.",
].join("\n")

const FAILED = [
  "[ASYNC DELEGATION TASK FAILED — d-4, task 1/2]",
  "One subagent in a background fan-out you dispatched has failed while its siblings are still",
  "running.",
  "Task: Read the changelog",
  "Status: failed   Duration: 12s",
  "Error: the file is not there",
].join("\n")

const single = (rows) => subagentResults(rows).get(1)

test("a delivery draws as the bot's message, with the subagent's result in it", () => {
  const row = delivery(1, SINGLE)
  const drawn = subagentMessage(row, single([row]))
  assert.equal(drawn.role, "assistant", "the bot's own message, never the user's")
  assert.equal(drawn.content, RESULT, "the result the subagent left, without the model's plumbing")
  assert.ok(!drawn.content.includes("--- RESULT ---"), "no marker of the notification it arrived as")
})

test("it names the delegation and the subagent the call was dispatched with", () => {
  const rows = [
    dispatched(1, { count: 1, delegation_id: "d-1", goals: [GOAL], subagent_ids: ["sa-0-ab12cd34"] }),
    delivery(2, SINGLE),
  ]
  const [result] = [...subagentResults(rows).values()]
  assert.equal(result.delegationId, "d-1", "the delegation the notification reported")
  assert.deepEqual(result.ids, ["sa-0-ab12cd34"], "its subagent")
  assert.deepEqual(result.goals, [GOAL], "and the goal it ran to")
})

test("a fan-out unit names only its own tasks", () => {
  const rows = [
    dispatched(1, {
      count: 3,
      delegation_id: "d-3",
      goals: ["Read the parser", "Audit the docs", "Count the tests"],
      subagent_ids: ["sa-0-1a2b3c4d", "sa-1-5e6f7a8b", "sa-2-9c0d1e2f"],
      units: [
        { delegation_id: "d-3-1", group: "a", task_indexes: [0] },
        { delegation_id: "d-3-2", group: "b", task_indexes: [1] },
        { delegation_id: "d-3-3", group: "c", task_indexes: [2] },
      ],
    }),
    delivery(2, BATCH),
  ]
  const result = subagentResults(rows).get(2)
  assert.equal(result.delegationId, "d-3-2")
  assert.deepEqual(result.ids, ["sa-1-5e6f7a8b"], "the subagent that ran this unit's task")
  assert.deepEqual(result.goals, ["Audit the docs"])
  assert.equal(result.text, [
    "--- ✓ TASK 2/3: Audit the docs  (status=completed, api_calls=4, 20s) ---",
    "The docs name every rule the parser follows.",
  ].join("\n"), "the unit's own block")
})

test("a failure is a result too, with the reason it carries", () => {
  const rows = [delivery(1, FAILED)]
  const result = subagentResults(rows).get(1)
  assert.equal(result.delegationId, "d-4")
  assert.deepEqual(result.goals, ["Read the changelog"])
  assert.match(result.text, /the file is not there/, "why it stopped")
})

test("without the call's dispatch row it still draws, unnamed", () => {
  const row = delivery(1, SINGLE)
  const result = subagentResults([row]).get(1)
  assert.deepEqual(result.ids, [], "no subagent id the transcript can name")
  assert.deepEqual(result.goals, [GOAL], "though its goal is in the notification")
  assert.equal(subagentMessage(row, result).content, RESULT)
})

test("a transcript from before deliveries loads as it did", () => {
  const rows = [
    { id: 1, role: "user", content: "Where does the parser read a reply?", timestamp: 1 },
    { id: 2, role: "assistant", content: RESULT, timestamp: 2 },
    { id: 3, role: "user", content: "Thanks!", timestamp: 3 },
  ]
  assert.deepEqual([...subagentResults(rows).keys()], [], "nothing claims to be a subagent's result")
  assert.deepEqual(rows.map(isSubagentResult), [false, false, false], "and no row is drawn as one")
})

test("a hidden row is not drawn as a result", () => {
  assert.equal(isSubagentResult({ display_kind: "hidden" }), false)
  assert.equal(isSubagentResult({ display_kind: null }), false)
  assert.equal(isSubagentResult({ display_kind: "async_delegation_complete" }), true)
})
