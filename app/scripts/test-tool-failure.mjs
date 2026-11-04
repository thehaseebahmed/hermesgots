/** The rule that reads a call's result (ADR 0098). */
import assert from "node:assert/strict"
import test from "node:test"

import { callOutcome, phrases } from "../src/lib/tools.ts"

const envelope = (fields) => JSON.stringify(fields)

test("a terminal command fails on its exit code, and says what the host said", () => {
  assert.deepEqual(
    callOutcome("terminal", envelope({ output: "", exit_code: 1, error: "Permission denied" })),
    { state: "failed", reason: "Permission denied" },
    "the host's own error is the reason",
  )
  assert.deepEqual(
    callOutcome("terminal", envelope({ output: "", exit_code: 2, error: null })),
    { state: "failed", reason: "Exit code 2" },
    "with nothing said, the exit code stands in",
  )
  assert.deepEqual(
    callOutcome("terminal", envelope({ output: "ok", exit_code: 0, error: null })),
    { state: "ok" },
    "and a command that exited 0 worked, whatever else its result carries",
  )
})

test("a result carrying error: null, or an empty one, is a call that worked", () => {
  assert.deepEqual(
    callOutcome(
      "read_file",
      envelope({ content: "a file", error: null, user_summary: "Read one file" }),
    ),
    { state: "ok" },
    "the key's presence is not the failure: its word is",
  )
  assert.deepEqual(
    callOutcome("read_file", envelope({ content: "", error: "" })),
    { state: "ok" },
    "and an empty error says nothing happened to fail",
  )
  assert.deepEqual(
    callOutcome("read_file", envelope({ content: "", error: "File not found: /etc/x" })),
    { state: "failed", reason: "File not found: /etc/x" },
    "a real error is one",
  )
})

test("a failure with nothing to say is still a failure, and the renderer owns the word", () => {
  assert.deepEqual(
    callOutcome("read_file", envelope({ content: "", success: false })),
    { state: "failed" },
    "no reason is not no failure",
  )
})

test("a call the reader turned down never ran, so it did not fail", () => {
  const refused = envelope({
    output: "",
    exit_code: -1,
    error: "BLOCKED: Command denied by user.",
    status: "blocked",
    user_summary: "You denied this command — it did not run.",
  })
  assert.deepEqual(callOutcome("terminal", refused), { state: "refused" }, "the host's blocked status")
})

test("a run's line counts a refused call apart from the ones that ran", () => {
  const ran = { toolCallId: "c-1", tool: "read_file", label: "/etc/hosts", status: "completed", startedAt: 1, endedAt: 2 }
  const refused = { toolCallId: "c-2", tool: "terminal", label: "rm -rf /var/log", status: "refused", startedAt: 1, endedAt: 2 }
  assert.deepEqual(
    phrases([refused, ran]),
    ["Refused a command", "Read a file"],
    "each kind in the order it first appears, and the refusal is not a run",
  )
  assert.deepEqual(phrases([refused]), ["Refused a command"], "and a run of nothing but refusals still says so")
  assert.deepEqual(phrases([ran]), ["Read a file"], "a call that ran reads as it always did")
})
