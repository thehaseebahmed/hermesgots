/**
 * A close's report as the app tells it (ADR 0075): what still has to be told, and in what words.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { closeLines, closeToldKey, closeUntold } from "../src/lib/close-report.ts"

const close = (facts = {}) => ({
  sessionId: "s-1",
  state: "done",
  startedAt: 100,
  endedAt: 200,
  repos: ["acme/app"],
  removed: true,
  kept: [],
  results: [],
  error: null,
  ...facts,
})

test("a close still running has nothing to tell", () => {
  assert.equal(closeUntold({}, "bot", close({ state: "closing", endedAt: null })), false)
  assert.equal(closeUntold({}, "bot", close({ state: "none" })), false)
})

test("a report is told once per device", () => {
  const key = closeToldKey("bot", "s-1")
  assert.equal(closeUntold({}, "bot", close()), true)
  assert.equal(closeUntold({ [key]: 100 }, "bot", close()), false)
  // A later close of the same session is news again; an earlier one is not.
  assert.equal(closeUntold({ [key]: 100 }, "bot", close({ startedAt: 300 })), true)
  assert.equal(closeUntold({ [key]: 300 }, "bot", close({ startedAt: 100 })), false)
})

test("a report belongs to the bot whose host closed the session", () => {
  const marks = { [closeToldKey("bot-a", "s-1")]: 100 }
  assert.equal(closeUntold(marks, "bot-a", close()), false)
  assert.equal(closeUntold(marks, "bot-b", close()), true)
})

test("a close that went as asked says nothing", () => {
  assert.deepEqual(closeLines(close()), [])
})

test("a kept tree is told with why", () => {
  assert.deepEqual(closeLines(close({ removed: false, kept: [{ name: "acme/app", reason: "dirty" }] })), [
    { tone: "info", text: "Kept acme/app: it has uncommitted changes." },
  ])
  assert.deepEqual(
    closeLines(close({ removed: false, kept: [{ name: "acme/app", reason: "unpushed" }] })),
    [{ tone: "info", text: "Kept acme/app: it has unpushed changes." }],
  )
})

test("a refusal names its repo only where the session had more than one", () => {
  const refused = close({
    results: [{ name: "acme/app", closed: null, branchDeleted: false, error: "GitHub said no." }],
  })
  assert.deepEqual(closeLines(refused, true), [
    { tone: "error", text: "acme/app: GitHub said no." },
  ])
  assert.deepEqual(closeLines(refused, false), [{ tone: "error", text: "GitHub said no." }])
})

test("a removal's own failure is told, even with nothing else to say", () => {
  assert.deepEqual(closeLines(close({ removed: false, error: "git refused to remove" })), [
    { tone: "error", text: "git refused to remove" },
  ])
})
