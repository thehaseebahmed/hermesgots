/**
 * A subagent's delivery is bookkeeping, not a message: the row Hermes writes when a delegated task
 * finishes is recognised as one so the fold can skip it — no bubble, no turn of its own — while a
 * wake prompt, a hidden row and an ordinary user row are none of it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { SUBAGENT_RESULT_KIND, isSubagentResult } from "../src/lib/subagent-results.ts"
import { WAKE_PROMPT_FOOTER, WAKE_PROMPT_HEADER } from "../src/lib/wake-prompt.ts"

/** The delivery row core writes: a `user` row whose display kind says it is a subagent's result. */
const delivery = (id, content) => ({
  id,
  role: "user",
  display_kind: SUBAGENT_RESULT_KIND,
  content,
  timestamp: 1_700_000_000,
})

/** The wake prompt the plugin posts after it: the same header, and no display kind at all. */
const wake = (id) => ({
  id,
  role: "user",
  content: [
    `${WAKE_PROMPT_HEADER}child-session]`,
    "A background subagent you dispatched earlier has finished.",
    "",
    WAKE_PROMPT_FOOTER,
  ].join("\n"),
  timestamp: 1_700_000_050,
})

test("a delivery row is a delivery, whatever its text says", () => {
  assert.equal(isSubagentResult(delivery(1, "anything the notification says")), true)
  assert.equal(
    isSubagentResult({ display_kind: SUBAGENT_RESULT_KIND }),
    true,
    "the kind is all it is",
  )
})

test("a wake prompt is not a delivery", () => {
  assert.equal(isSubagentResult(wake(2)), false, "it is the model's input, not a finished subagent")
})

test("a hidden row is not a delivery, and a delivery is", () => {
  assert.equal(isSubagentResult({ display_kind: "hidden" }), false)
  assert.equal(isSubagentResult({ display_kind: null }), false)
  assert.equal(isSubagentResult({ display_kind: SUBAGENT_RESULT_KIND }), true)
})

test("an ordinary user row is not a delivery", () => {
  const row = { id: 3, role: "user", content: "Thanks!", timestamp: 1 }
  assert.equal(isSubagentResult(row), false, "a user's own message draws a message of its own")
})
