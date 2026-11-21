/**
 * What a build's one row and its visit markers say, as a pure rule: `build-steps.ts` is read here
 * without a DOM, so a change in the words a build states is a failed test rather than a screen
 * nobody re-read.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { atWork, flagWords, phaseWord, rowWords, visitWords } from "../src/lib/build-steps.ts"

test("a phase's word is the lane's own, and a phase nobody named is Working", () => {
  assert.equal(phaseWord("planning"), "Planning")
  assert.equal(phaseWord("waiting"), "Waiting")
  assert.equal(phaseWord("building"), "Building")
  assert.equal(phaseWord("checking"), "Checking")
  assert.equal(phaseWord("publishing"), "Publishing")
  assert.equal(phaseWord("somewhere-new"), "Working", "a phase the record invents reads as working")
})

test("a check's flag is said in the lane's words", () => {
  assert.equal(flagWords("passing"), "Checks passed")
  assert.equal(flagWords("failing"), "Checks failed")
  assert.equal(flagWords("unchecked"), "Not checked")
  assert.equal(flagWords("something-else"), undefined, "a flag nobody wrote reads as nothing")
})

test("a build is at work until it is published, failed or stopped", () => {
  assert.equal(atWork({ phase: "planning" }), true)
  assert.equal(atWork({ phase: "waiting" }), true)
  assert.equal(atWork({ phase: "building" }), true)
  assert.equal(atWork({ phase: "publishing" }), true)
  assert.equal(atWork({ phase: "published" }), false)
  assert.equal(atWork({ phase: "failed" }), false)
  assert.equal(atWork({ phase: "stopped" }), false)
})

test("a build's row says what it is doing while it works", () => {
  assert.equal(
    rowWords({ phase: "building", activity: "Building the page" }),
    "Building the page",
    "the host's own activity line is the row's words",
  )
  assert.equal(
    rowWords({ phase: "waiting", activity: "Waiting for your approval" }),
    "Waiting for your approval",
    "a wait is stated as the wait it is",
  )
  assert.equal(
    rowWords({ phase: "planning" }),
    "Planning",
    "a record that names no activity says the phase the build is in",
  )
  assert.equal(
    rowWords({ phase: "waiting" }),
    "Waiting",
    "and a build waiting on the reader never says the host is busy",
  )
})

test("a build's row becomes the version it published, or the answer it gave", () => {
  assert.equal(
    rowWords({ phase: "published", version: 3 }),
    "Version 3 published",
    "a build that published a version names it",
  )
  assert.equal(
    rowWords({ phase: "published" }),
    "Answered",
    "a build that published nothing answered rather than shipping",
  )
  assert.equal(rowWords({ phase: "failed" }), "Failed", "a build that failed says so")
  assert.equal(rowWords({ phase: "stopped" }), "Stopped", "and one that was stopped says that")
})

test("a visit's marker says its phase, what a check found and how long it took", () => {
  assert.equal(
    visitWords({ phase: "planning", startedAt: 0, endedAt: 2_000 }),
    "Planning · 2.0s",
    "a closed visit says its span",
  )
  assert.equal(
    visitWords({ phase: "checking", startedAt: 0, endedAt: 1_500, flag: "passing" }),
    "Checking · Checks passed · 1.5s",
    "a checking visit says what its check found, between its phase and its span",
  )
  assert.equal(
    visitWords({ phase: "publishing", startedAt: 0 }),
    "Publishing",
    "an open visit says no span, since the record has not dated its end",
  )
  assert.equal(
    visitWords({ phase: "waiting", startedAt: 0, endedAt: 88_000 }),
    "Waiting · 1m 28s",
    "a wait is said in minutes and seconds",
  )
})
