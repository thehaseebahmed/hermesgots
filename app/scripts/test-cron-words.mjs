/**
 * What a cron call's row says it did. Every `cronjob_manage` call used to read as "Used a tool",
 * whatever its action — a schedule that was listed, a job that was run — so the words never told
 * the user what happened. The action is stamped where the call's arguments are in hand (the
 * transcript parse), and a row stored before the stamp is read from its label, which for this tool
 * is the action word itself. A call whose action the table doesn't know must still read as the
 * generic tool row: the thread's worst case is a vague row, never a claim that a job ran.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { activityOf, actionOfPreview, kindOf, phrases } from "../src/lib/tools.ts"

const CRON = "cronjob_manage"

/** A cron call as a thread stores it: its label, its status, and the action stamped at ingest. */
const call = (label, extra = {}) => ({
  toolCallId: "c1",
  tool: CRON,
  label,
  status: "completed",
  startedAt: 0,
  ...extra,
})

/** The call's action stamped by the transcript parse, its label being the same word. */
const stamped = (action) => call(action, { action })

test("each cron action reads as the action it took", () => {
  const words = {
    create: "Created a cron job",
    list: "Listed cron jobs",
    remove: "Removed a cron job",
    update: "Updated a cron job",
    run: "Ran a cron job",
    pause: "Paused a cron job",
    resume: "Resumed a cron job",
  }
  for (const [action, phrase] of Object.entries(words))
    assert.equal(activityOf(stamped(action)), phrase, `${action} says what it did`)
})

test("the same action reads in the present while the call runs", () => {
  const words = {
    create: "Creating a cron job",
    list: "Listing cron jobs",
    remove: "Removing a cron job",
    update: "Updating a cron job",
    run: "Running a cron job",
    pause: "Pausing a cron job",
    resume: "Resuming a cron job",
  }
  for (const [action, phrase] of Object.entries(words))
    assert.equal(
      activityOf({ ...stamped(action), status: "running" }),
      phrase,
      `${action} says what it is doing`,
    )
})

test("an action the table does not know reads as a tool, never as a job it ran", () => {
  assert.equal(activityOf(stamped("frobnicate")), "Used a tool", "an action no table entry knows")
  assert.equal(activityOf(call(CRON)), "Used a tool", "no stamp, and a label that names nothing")
  // The transcript's JSON fallback for a call whose arguments named no action at all.
  assert.equal(activityOf(call('{"name":"nightly","schedule":"0 3 * * *"}')), "Used a tool")
})

test("a row stored before the stamp is read from its label, which is the action word", () => {
  assert.equal(activityOf(call("create")), "Created a cron job", "the preview's own word")
  assert.equal(activityOf(call(" list ")), "Listed cron jobs", "trimmed, as the stamp is")
  assert.equal(activityOf(call("run")), "Ran a cron job")
})

test("one group says each action it took, once", () => {
  assert.deepEqual(
    phrases([stamped("create"), stamped("list"), stamped("run"), stamped("create")]),
    ["Created a cron job", "Listed cron jobs", "Ran a cron job"],
    "three actions, each once, in the order they appear",
  )
})

test("every cron action is drawn with the cron icon, an unknown one with the tool's", () => {
  for (const action of ["create", "list", "remove", "update", "run", "pause", "resume"])
    assert.equal(kindOf(stamped(action)).id, "cron", `${action} is a cron call`)
  assert.equal(kindOf(stamped("frobnicate")).id, "used", "an unknown action is a generic tool")
  assert.equal(kindOf(call(CRON)).id, "used")
})

test("the live stream stamps a cron call from its own preview, before the transcript lands", () => {
  assert.equal(actionOfPreview(CRON, "create"), "create", "the preview is the action itself")
  assert.equal(
    actionOfPreview(CRON, " CREATE "),
    "create",
    "trimmed and lower-cased like the stamp",
  )
  assert.equal(actionOfPreview(CRON, "frobnicate"), undefined, "no action the table knows")
  assert.equal(actionOfPreview(CRON, CRON), undefined, "the tool's own name names no action")
  assert.equal(actionOfPreview("read_file", "create"), undefined, "no other tool is read this way")
  // The stamped row then reads the same before and after the transcript's own stamp arrives.
  const live = { ...call("create"), action: actionOfPreview(CRON, "create") }
  assert.equal(activityOf(live), activityOf(stamped("create")))
})
