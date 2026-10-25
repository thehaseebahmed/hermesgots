/**
 * The sixteen notification types, each named for the event it reports: the title as the web's list
 * shows it, how loudly its channel is created, whether it starts on, and the name Android's flat
 * list shows (the feature's in front, since that list has no headings). A device that already has
 * the channels keeps them, so the ids here are the ones that were shipped and must not move.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { PUSH_CATEGORIES, channelName } from "../src/lib/push-kinds.ts"

/** What each type is called, how loudly its channel is created, and whether it starts on. */
const NAMED = [
  ["chat_input", "Questions and approvals", 4, true],
  ["chat_run_failed", "Run failed", 3, true],
  ["chat_run_done", "Run finished", 3, false],
  ["code_input", "Questions, approvals, plans", 4, true],
  ["code_run_failed", "Run failed", 3, true],
  ["code_run_done", "Run finished", 3, false],
  ["code_pr_checks", "Pull request checks failing", 3, true],
  ["code_pr_merged", "Pull request merged", 2, false],
  ["code_afk_pr", "Pull request ready to review", 3, true],
  ["code_setup_failed", "Project setup failed", 3, true],
  ["routine_failed", "Routine failed", 3, true],
  ["research_input", "Brief or scope to review", 4, true],
  ["research_done", "Mission ready", 3, true],
  ["research_failed", "Mission failed", 3, true],
  ["meeting_done", "Notes ready", 3, true],
  ["meeting_failed", "Notes failed", 3, true],
]

/** The ids the table gives an importance, in the order it lists them. */
const at = (importance) => NAMED.filter(([, , level]) => level === importance).map(([id]) => id)
/** The ids the table starts off, and the ones it starts on. */
const off = NAMED.filter(([, , , on]) => !on).map(([id]) => id)

const byId = (id) => {
  const category = PUSH_CATEGORIES.find((c) => c.id === id)
  assert.ok(category, `no category ${id}`)
  return category
}

test("every type reads as the event it reports", () => {
  assert.equal(PUSH_CATEGORIES.length, NAMED.length, "the sixteen stay sixteen")
  for (const [id, title] of NAMED) assert.equal(byId(id).title, title, id)
})

test("every type is created on the phone at the importance its row names", () => {
  for (const [id, , importance] of NAMED) assert.equal(byId(id).importance, importance, id)
})

test("a type starts on or off as it always did", () => {
  assert.deepEqual(off, ["chat_run_done", "code_run_done", "code_pr_merged"])
  for (const [id, , , on] of NAMED) assert.equal(byId(id).on, on, id)
})

test("a title is the event, not a sentence about it", () => {
  for (const category of PUSH_CATEGORIES) {
    assert.doesNotMatch(
      category.title,
      /^(A|An|The|This|Your|It)\b/i,
      `${category.id} names the event with no article or pronoun`,
    )
  }
})

test("the two renamed types are the only wording that changed", () => {
  const renamed = {
    code_afk_pr: "Pull request ready to review",
    research_input: "Brief or scope to review",
  }
  for (const [id, title] of Object.entries(renamed)) assert.equal(byId(id).title, title)
  // The other fourteen keep the wording they shipped with, as this table has it.
  assert.deepEqual(
    PUSH_CATEGORIES.filter((c) => !(c.id in renamed)).map((c) => c.title),
    NAMED.filter(([id]) => !(id in renamed)).map(([, title]) => title),
  )
})

test("only what waits on the user peeks", () => {
  assert.deepEqual(at(4), ["chat_input", "code_input", "research_input"])
})

test("a failure nobody saw coming does not take over the screen", () => {
  assert.equal(byId("chat_run_failed").importance, 3)
  assert.equal(byId("code_run_failed").importance, 3)
})

test("a merged pull request is the quietest news there is", () => {
  assert.deepEqual(at(2), ["code_pr_merged"])
})

test("every failure and every completion makes a sound but does not peek", () => {
  const quiet = PUSH_CATEGORIES.filter((c) => c.importance === 3).map((c) => c.id)
  assert.deepEqual(quiet, at(3), "the twelve in the list are the twelve in the table")
  assert.equal(quiet.length, 12)
})

test("the ids are the ones a device already has its channels under", () => {
  assert.deepEqual(
    PUSH_CATEGORIES.map((c) => c.id),
    NAMED.map(([id]) => id),
    "renaming moves no id, so no switch is lost",
  )
})

test("Android's list carries the feature, since it has no headings", () => {
  assert.equal(channelName(byId("code_afk_pr")), "Code: Pull request ready to review")
  assert.equal(
    channelName(byId("chat_run_failed")),
    "Chats: Run failed",
    "two Run failed, told apart",
  )
  assert.equal(channelName(byId("research_input")), "Research: Brief or scope to review")
  assert.equal(channelName(byId("meeting_done")), "Meetings: Notes ready")
  assert.equal(
    channelName(byId("routine_failed")),
    "Routine failed",
    "Routines carries no prefix: its one type already names it",
  )
})

test("every channel is named for its feature and its event", () => {
  const features = {
    chats: "Chats",
    code: "Code",
    routines: "Routines",
    research: "Research",
    meetings: "Meetings",
  }
  for (const category of PUSH_CATEGORIES) {
    const expected =
      category.feature === "routines"
        ? category.title
        : `${features[category.feature]}: ${category.title}`
    assert.equal(channelName(category), expected, category.id)
  }
})
