/**
 * The sixteen notification types, each named for the event it reports: the title as the web's list
 * shows it, the channel name Android's flat list shows (the feature's name in front, since that list
 * has no headings), and the importance a channel is created with. A device that already has the
 * channels keeps them, so the ids here are the ones that were shipped and must not move.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { PUSH_CATEGORIES, channelName } from "../src/lib/push-kinds.ts"

/** What each type is called, and how loudly its channel is created. */
const NAMED = [
  ["chat_input", "Questions and approvals", 4],
  ["chat_run_failed", "Run failed", 3],
  ["chat_run_done", "Run finished", 3],
  ["code_input", "Questions, approvals, plans", 4],
  ["code_run_failed", "Run failed", 3],
  ["code_run_done", "Run finished", 3],
  ["code_pr_checks", "Pull request checks failing", 3],
  ["code_pr_merged", "Pull request merged", 2],
  ["code_afk_pr", "Pull request ready to review", 3],
  ["code_setup_failed", "Project setup failed", 3],
  ["routine_failed", "Routine failed", 3],
  ["research_input", "Brief or scope to review", 4],
  ["research_done", "Mission ready", 3],
  ["research_failed", "Mission failed", 3],
  ["meeting_done", "Notes ready", 3],
  ["meeting_failed", "Notes failed", 3],
]

const byId = (id) => {
  const category = PUSH_CATEGORIES.find((c) => c.id === id)
  assert.ok(category, `no category ${id}`)
  return category
}

test("every type reads as the event it reports", () => {
  assert.equal(PUSH_CATEGORIES.length, NAMED.length, "the sixteen stay sixteen")
  for (const [id, title] of NAMED) assert.equal(byId(id).title, title, id)
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
  // The other fourteen keep the wording they shipped with, listed here so a silent edit is caught.
  const unchanged = [
    "Questions and approvals",
    "Run failed",
    "Run finished",
    "Questions, approvals, plans",
    "Run failed",
    "Run finished",
    "Pull request checks failing",
    "Pull request merged",
    "Project setup failed",
    "Routine failed",
    "Mission ready",
    "Mission failed",
    "Notes ready",
    "Notes failed",
  ]
  assert.deepEqual(
    PUSH_CATEGORIES.filter((c) => c.id !== "code_afk_pr" && c.id !== "research_input").map(
      (c) => c.title,
    ),
    unchanged,
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

test("only what waits on the user peeks", () => {
  const loud = PUSH_CATEGORIES.filter((c) => c.importance === 4).map((c) => c.id)
  assert.deepEqual(loud, ["chat_input", "code_input", "research_input"])
})

test("a failure nobody saw coming does not take over the screen", () => {
  assert.equal(byId("chat_run_failed").importance, 3)
  assert.equal(byId("code_run_failed").importance, 3)
})

test("a merged pull request is the quietest news there is", () => {
  const silent = PUSH_CATEGORIES.filter((c) => c.importance === 2).map((c) => c.id)
  assert.deepEqual(silent, ["code_pr_merged"])
})

test("every failure and every completion makes a sound but does not peek", () => {
  const quiet = PUSH_CATEGORIES.filter((c) => c.importance === 3).map((c) => c.id)
  assert.deepEqual(quiet, [
    "chat_run_failed",
    "chat_run_done",
    "code_run_failed",
    "code_run_done",
    "code_pr_checks",
    "code_afk_pr",
    "code_setup_failed",
    "routine_failed",
    "research_done",
    "research_failed",
    "meeting_done",
    "meeting_failed",
  ])
})

test("the ids are the ones a device already has its channels under", () => {
  assert.deepEqual(
    PUSH_CATEGORIES.map((c) => c.id),
    NAMED.map(([id]) => id),
    "renaming moves no id, so no switch is lost",
  )
})

test("a type starts on or off as it always did", () => {
  const off = PUSH_CATEGORIES.filter((c) => !c.on).map((c) => c.id)
  assert.deepEqual(off, ["chat_run_done", "code_run_done", "code_pr_merged"])
})
