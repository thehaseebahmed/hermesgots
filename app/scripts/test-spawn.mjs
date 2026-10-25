/**
 * Did this call set a subagent to work? The one rule a thread's card, its agents poll and its row's
 * words all ask — asked here of each shape a stored call arrives in, because the shapes a render
 * sees are what decide whether a chat can claim work that never ran (ADR 0053).
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  actionOf,
  actionOfLabel,
  controlWords,
  DELEGATE_TOOL,
  spawnInFlight,
  spawnedAgent,
} from "../src/lib/spawn.ts"

const GOAL = "You are the Reviewer for CP3: read the parser end to end"

/** A `delegate_task` call as a thread stores it: the label, and the action stamped at ingest. */
const call = (label, action) => ({
  tool: DELEGATE_TOOL,
  label,
  ...(action === undefined ? {} : { action }),
})

test("a call whose arguments named an action is a spawn only where that action spawned", () => {
  assert.equal(spawnedAgent(call(GOAL, "spawn")), true, "spawn sets a subagent to work")
  for (const action of ["list", "steer", "stop", "frobnicate"])
    assert.equal(spawnedAgent(call(GOAL, action)), false, `${action} runs no agent`)
})

test("a call whose arguments named no action is a spawn, unless its label names a control", () => {
  assert.equal(spawnedAgent(call(GOAL)), true, "a goal alone is the shape a spawn arrives as")
  assert.equal(spawnedAgent(call("3 delegated tasks: one | two")), true, "so is a tasks batch")
  // Stored before the stamp: the preview's words.
  assert.equal(spawnedAgent(call("list")), false)
  assert.equal(spawnedAgent(call("steer sub-1")), false)
  assert.equal(spawnedAgent(call("stop sub-1")), false)
  // Stored before the stamp: the JSON fallback the transcript used to write.
  assert.equal(spawnedAgent(call('{"action":"list","subagent_id":null}')), false)
  assert.equal(spawnedAgent(call('{"action":"stop","subagent_id":"sub-2"}')), false)
  // A label that names nothing proves nothing, so the call draws a row rather than a card.
  assert.equal(spawnedAgent(call(DELEGATE_TOOL)), false)
  assert.equal(spawnedAgent(call("")), false)
  assert.equal(spawnedAgent(call(undefined)), false)
})

test("no other tool is ever a spawn, whatever it is called", () => {
  assert.equal(spawnedAgent({ tool: "read_file", label: "list" }), false)
  assert.equal(spawnedAgent({ tool: "terminal", label: GOAL, action: "spawn" }), false)
})

test("a goal that opens on a control word is still work, while a preview stays a control", () => {
  // A preview is the action and at most the id it names; a word more reads as the goal it is.
  assert.equal(spawnedAgent(call("list all the files in src")), true)
  assert.equal(spawnedAgent(call("steer the team toward the parser")), true)
  assert.equal(actionOfLabel("steer sub-1"), "steer", "and the preview still names its action")
})

test("the stamp is the action the arguments named, trimmed and lower-cased", () => {
  assert.equal(actionOf({ action: "LIST" }), "list")
  assert.equal(actionOf({ action: " steer ", subagent_id: "sub-1" }), "steer")
  assert.equal(
    actionOf({ action: "ship" }),
    "ship",
    "any tool's action is stamped, not just this one",
  )
  assert.equal(actionOf({ goal: GOAL }), undefined, "a spawn by its goal names no action")
  assert.equal(actionOf({ action: "" }), undefined)
  assert.equal(actionOf({ action: 3 }), undefined)
  assert.equal(actionOf("list"), undefined)
  assert.equal(actionOf(undefined), undefined)
})

test("a control call's words are the ones Hermes previews, from its own arguments", () => {
  // `_delegate_action_preview` in agent/display.py: f"{action} {subagent_id}".strip().
  assert.equal(controlWords({ action: "list" }), "list", "a list names no id")
  assert.equal(controlWords({ action: "steer", subagent_id: "sub-1" }), "steer sub-1")
  assert.equal(controlWords({ action: "stop", subagent_id: "sub-2" }), "stop sub-2")
  assert.equal(controlWords({ action: "stop", subagent_id: null }), "stop")
  assert.equal(controlWords({ goal: GOAL }), undefined, "a spawn keeps its goal")
  assert.equal(controlWords({ action: "spawn", goal: GOAL }), undefined)
  assert.equal(controlWords({ tasks: [{ goal: GOAL }] }), undefined)
})

test("the same call reads the same while it streams and after the chat reloads", () => {
  for (const args of [
    { action: "list" },
    { action: "steer", subagent_id: "sub-1" },
    { action: "stop", subagent_id: "sub-2" },
  ]) {
    const streamed = controlWords(args)
    assert.equal(actionOfLabel(streamed), args.action, "the preview names the stamped action")
    assert.equal(spawnedAgent(call(streamed, actionOf(args))), false, "and classifies the same")
    assert.equal(spawnedAgent(call(streamed)), false, "label alone, as a row stored before it")
  }
})

test("a chat with no spawn in flight does not enable the agents poll", () => {
  const running = (label, action) => ({ ...call(label, action), status: "running" })
  const done = (label, action) => ({ ...call(label, action), status: "completed" })
  // The ticket's own case: the only delegation-shaped call listed, so there is no agent to read.
  assert.equal(spawnInFlight([{ tools: [running("list", "list")] }]), false)
  assert.equal(spawnInFlight([{ tools: [running("steer sub-1", "steer")] }]), false)
  assert.equal(
    spawnInFlight([{ tools: [running("list")] }]),
    false,
    "an old row, read by its label",
  )
  assert.equal(spawnInFlight([{ tools: [running("list", "list"), done(GOAL)] }]), false)
  // And the poll does run where a subagent was set to work and hasn't finished.
  assert.equal(spawnInFlight([{ tools: [running(GOAL)] }]), true)
  assert.equal(spawnInFlight([{ tools: [running(GOAL, "spawn")] }]), true)
  assert.equal(spawnInFlight([{ tools: [done(GOAL)] }]), false, "a finished spawn waits on nothing")
  assert.equal(spawnInFlight([]), false)
  assert.equal(spawnInFlight(undefined), false)
})
