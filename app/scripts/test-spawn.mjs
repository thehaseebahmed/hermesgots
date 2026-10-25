/**
 * Did this call set a subagent to work? The one rule a thread's card, its agents poll and its row's
 * words all ask — asked here of each shape a stored call arrives in, because the shapes a render sees
 * are what decide whether a chat can claim work that never ran (ADR 0053).
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  actionOf,
  actionOfJsonLabel,
  actionOfWords,
  controlAction,
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

test("an envelope label proves a spawn where its arguments do, and is a row where they don't", () => {
  // A transcript row whose arguments fell back as its label: a batch's `tasks` and a spawn's `goal`
  // are what a spawn was given, so the card survives a reload. An `action` says what the call did —
  // `spawn` set work going, and every other action ran none.
  assert.equal(spawnedAgent(call('{"tasks":[{"goal":"one"}]}')), true, "a batch is a spawn")
  assert.equal(
    spawnedAgent(call('{"tasks":[{"goal":"one"},{"goal":"two"}],"model":"test/model"}')),
    true,
    "however many tasks it names",
  )
  assert.equal(spawnedAgent(call('{"goal":"Fix it"}')), true, "a goal alone is a spawn, however short")
  assert.equal(spawnedAgent(call('{"action":"spawn","goal":"read the parser"}')), true)
  for (const label of [
    '{"action":"list","subagent_id":null}',
    '{"action":"steer","subagent_id":"sub-1"}',
    '{"action":"archive"}',
    '{"action":"frobnicate","subagent_id":"sub-1"}',
    '{"goal":""}',
    '{"tasks":[]}',
    '{"subagent_id":"sub-2"}',
  ])
    assert.equal(spawnedAgent(call(label)), false, `${label} draws a tool row`)
  // A label that opens on a brace but isn't an envelope proves nothing, so it stays a row.
  for (const label of ["{ not json", "{ cat package.json; }", "{}"])
    assert.equal(spawnedAgent(call(label)), false, `${label} draws a tool row`)
})

test("an envelope label still names the control actions it did run none of", () => {
  assert.equal(controlAction(call('{"action":"steer","subagent_id":"sub-1"}')), "steer")
  assert.equal(controlAction(call('{"action":"list"}')), "list")
})

test("no other tool is ever a spawn, whatever it is called", () => {
  assert.equal(spawnedAgent({ tool: "read_file", label: "list" }), false)
  assert.equal(spawnedAgent({ tool: "terminal", label: GOAL, action: "spawn" }), false)
})

test("a goal that opens on a control word is still work, while a preview stays a control", () => {
  // A preview is the action and at most the id it names; a word more reads as the goal it is.
  for (const goal of ["list all the files in src", "steer the team toward the parser", "stop the"])
    assert.equal(spawnedAgent(call(goal)), true, `${goal} is the work, not an action`)
  assert.equal(actionOfWords("steer sub-1"), "steer", "and the preview still names its action")
})

test("a control word stamps only where the word after it looks like a subagent's id", () => {
  // `_delegate_action_preview` prints `{action} {subagent_id}`, so the second word is an id — never
  // the short plain word a goal opens with ("stop the parser", "list it").
  for (const label of ["stop the", "list it", "steer a", "stop all"])
    assert.equal(actionOfWords(label), undefined, `${label} names no id, so no action`)
  for (const label of ["steer sub-1", "stop sa-1-4f2a", "stop 20260521_141233_ab12cd"])
    assert.equal(actionOfWords(label), label.split(" ")[0], `${label} names an id`)
  assert.equal(actionOfWords("list"), "list", "a list names no id at all")
  assert.equal(actionOfWords("list 3"), undefined, "and a bare number is not an id either")
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

test("a JSON envelope's action is read for any tool, and a field cut short still says it", () => {
  assert.equal(actionOfJsonLabel('{"action":"list","subagent_id":null}'), "list")
  assert.equal(actionOfJsonLabel('{"action":"archive"}'), "archive", "not only a control action")
  assert.equal(actionOfJsonLabel('{"action":"ship","title":"feat: a thing…'), "ship")
  assert.equal(actionOfJsonLabel('{"goal":"read the parser"}'), undefined, "no action field")
  assert.equal(actionOfJsonLabel("steer sub-1"), undefined, "words are actionOfWords' to read")
  assert.equal(actionOfJsonLabel(undefined), undefined)
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

test("the stamp outranks a label, and only a control action is one", () => {
  assert.equal(controlAction(call("list", "steer")), "steer", "the stamp wins")
  assert.equal(controlAction(call("steer sub-1")), "steer", "else the label's words")
  assert.equal(controlAction(call(GOAL, "spawn")), undefined, "a spawn is not a control")
  assert.equal(controlAction(call("stop the parser")), undefined, "nor is a two-word goal")
})

test("the same call reads the same while it streams and after the chat reloads", () => {
  for (const args of [
    { action: "list" },
    { action: "steer", subagent_id: "sub-1" },
    { action: "stop", subagent_id: "sub-2" },
  ]) {
    const streamed = controlWords(args)
    assert.equal(actionOfWords(streamed), args.action, "the preview names the stamped action")
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
  assert.equal(
    spawnInFlight([{ tools: [running('{"tasks":[{"goal":"one"},{"goal":"two"}]}')] }]),
    true,
    "a batch stored as its arguments is a spawn in flight too",
  )
  assert.equal(
    spawnInFlight([{ tools: [running('{"action":"stop","subagent_id":"sub-2"}')] }]),
    false,
    "while a stop still asks for nothing",
  )
  assert.equal(spawnInFlight([{ tools: [done(GOAL)] }]), false, "a finished spawn waits on nothing")
  assert.equal(spawnInFlight([]), false)
  assert.equal(spawnInFlight(undefined), false)
})
