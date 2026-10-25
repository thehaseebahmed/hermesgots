/**
 * What a pull request call's row says it did, as a pure rule: the action its arguments named, or —
 * on a row stored before the stamp — the label it fell back to, its arguments as JSON.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { activityOf, kindOf, PR_TOOL, phrases } from "../src/lib/tools.ts"

const TITLE = "feat: add a dry-run flag to log rotation"

/** The arguments Hermes's tool takes: an action, and for ship a title and a body. */
const args = (action) => JSON.stringify({ action, title: TITLE, body: "## Summary" })

/** A row the transcript's parse left behind: its label is the arguments as JSON, its action stamped. */
const row = (action, extra = {}) => ({
  toolCallId: `call_${action}`,
  tool: PR_TOOL,
  label: args(action),
  action,
  status: "completed",
  startedAt: 0,
  endedAt: 1000,
  ...extra,
})

/** A row as the live stream draws it: Hermes previews nothing, so its label is the tool's own name. */
const streamed = (extra = {}) => ({
  toolCallId: "run-1:3",
  tool: PR_TOOL,
  label: PR_TOOL,
  status: "running",
  startedAt: 0,
  ...extra,
})

test("each pull request action reads as what it took, not as an opening", () => {
  assert.deepEqual(
    phrases(["ship", "push", "update", "status"].map((action) => row(action))),
    [
      "Opened a pull request",
      "Pushed the branch",
      "Updated a pull request",
      "Checked a pull request",
    ],
    "four actions, four phrases, in the order they ran",
  )
})

test("the same action reads in the present while the call runs", () => {
  assert.deepEqual(
    phrases(
      ["ship", "push", "update", "status"].map((action) => row(action, { status: "running" })),
    ),
    [
      "Opening a pull request",
      "Pushing the branch",
      "Updating a pull request",
      "Checking a pull request",
    ],
  )
})

test("an action the tool never took reads as the generic row, never as a claim", () => {
  // Merging and closing are the user's decision, so the tool refuses them: a host that streams such
  // a call anyway must not draw *Updated* over a write that never happened — nor *Opened* over
  // anything.
  assert.equal(activityOf(row("merge")), "Used a tool")
  assert.equal(activityOf(row("close")), "Used a tool")
  assert.equal(activityOf(streamed({ status: "completed" })), "Used a tool", "and no preview says")
})

test("a row stored before the stamp reads its action from the label it fell back to", () => {
  const done = (extra = {}) => streamed({ status: "completed", ...extra })
  // The transcript's JSON label, with no stamp: an old row, drawn as the call it was.
  assert.equal(activityOf(done({ label: args("status") })), "Checked a pull request")
  assert.equal(activityOf(done({ label: '{"action":"merge","pr":27}' })), "Used a tool")
  // A streamed call's label is the call's title — the words of a pull request, not an action.
  assert.equal(activityOf(done({ label: TITLE })), "Used a tool")
  // A stamp outranks a label that would say more.
  assert.equal(
    activityOf(done({ label: args("ship"), action: "status" })),
    "Checked a pull request",
  )
})

test("the legacy open_pull_request tool keeps its own words", () => {
  assert.equal(
    activityOf({
      toolCallId: "c-legacy",
      tool: "open_pull_request",
      label: TITLE,
      status: "completed",
      startedAt: 0,
    }),
    "Opened a pull request",
    "unchanged: it only ever opened",
  )
})

test("the four actions are four kinds, and share the pull request icon", () => {
  // The row groups calls by their kind, so two actions sharing one would read as a single phrase —
  // and *Opened* would swallow the other three. They differ by kind and agree on the icon.
  const kinds = ["ship", "push", "update", "status"].map((action) => kindOf(row(action)))
  assert.deepEqual(
    kinds.map((kind) => kind.id),
    ["pr", "pr", "pr", "pr"],
    "one icon for all of them",
  )
  assert.equal(new Set(kinds).size, 4, "four groups, four phrases")
  assert.equal(kindOf(streamed()).id, "used", "and a call the stream can't word is its own row")
})
