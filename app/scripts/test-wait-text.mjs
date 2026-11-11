/**
 * The sentence a waiting session says, wherever it is drawn: Code's row reads it of the reason the
 * bot's server reports, and a bot's chat row reads it of the question or the approval its own reply
 * carries. One function, so the two screens cannot word the same wait differently — and it is a rule
 * of its own (`lib/wait-text.ts`) rather than a part of the poll, which is what lets this run with no
 * DOM, no database and no bot at all.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { reasonText } from "../src/lib/wait-text.ts"

test("a question is one answer, or the count of them", () => {
  assert.equal(reasonText({ kind: "question", count: 1 }), "Awaiting your answer")
  assert.equal(reasonText({ kind: "question", count: 3 }), "3 questions to answer")
})

test("an approval says the command, and says what it is where the host named none", () => {
  assert.equal(reasonText({ kind: "approval", command: "rm -rf build" }), "Approve rm -rf build")
  // A command is drawn on one line whatever its own breaks, and a blank one names nothing.
  assert.equal(reasonText({ kind: "approval", command: "npm test\n--watch" }), "Approve npm test")
  assert.equal(reasonText({ kind: "approval", command: "  " }), "Needs approval to run a command")
  assert.equal(reasonText({ kind: "approval" }), "Needs approval to run a command")
})

test("a plan and a stalled run say what they are, in the host's own words", () => {
  assert.equal(reasonText({ kind: "plan" }), "Plan ready for review")
  assert.equal(reasonText({ kind: "stalled", reason: "The run failed." }), "The run failed.")
})

test("a kind this build has never heard of still says the session wants the user", () => {
  // The server may land a reason before the app knows it; it is never a reason to draw nothing.
  assert.equal(reasonText({ kind: "invented" }), "Needs you")
})
