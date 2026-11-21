/**
 * The lane's steps as a pure rule (G2, G6): which of a build's visits draw a marker, whether one is
 * still open, and the words its marker says. A build's record holds every phase it visited, but the
 * lane draws only the visits that did work — Waiting's words are the composer's plan card, and a
 * Publishing visit holds no turns — so a build that planned, waited, built, checked, built again,
 * checked again and published draws five markers, in the order they happened.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { isOpen, markersOf, stepWords } from "../src/lib/build-steps.ts"

/** One visit as the host answers it, mapped by `canvases.ts`'s `buildRowOf`. */
const step = (phase, startedAt, endedAt, flag) => ({
  phase,
  startedAt,
  ...(endedAt === undefined ? {} : { endedAt }),
  ...(flag === undefined ? {} : { flag }),
})

/** A build that fixed what a failed check found, and passed the next time. */
const BUILD = {
  steps: [
    step("planning", 0, 2_000),
    step("waiting", 2_000, 90_000),
    step("building", 90_000, 120_500),
    step("checking", 120_500, 121_000, "failing"),
    step("building", 121_000, 130_000),
    step("checking", 130_000, 131_500, "passing"),
    step("publishing", 131_500, 132_000),
  ],
}

test("a build draws a marker for each visit that did work, in the order it happened", () => {
  assert.deepEqual(
    markersOf(BUILD).map((one) => one.phase),
    ["planning", "building", "checking", "building", "checking"],
    "planning, building and checking draw; waiting and publishing do not, and nothing is deduplicated",
  )
})

test("a build older than the record draws no markers", () => {
  assert.deepEqual(markersOf({}), [], "no steps is no marker rather than an empty one to press")
  assert.deepEqual(markersOf({ steps: [] }), [], "and neither is an empty list of them")
})

test("a step is open until it has an end", () => {
  assert.equal(isOpen(step("building", 5_000)), true, "the build's current step has no end")
  assert.equal(isOpen(step("building", 5_000, 6_000)), false, "a visit the build left has one")
})

test("an open marker says its phase and nothing more", () => {
  assert.equal(stepWords(step("building", 5_000), "Building"), "Building")
})

test("a closed marker says its phase and the span it took", () => {
  assert.equal(stepWords(step("planning", 0, 2_000), "Planning"), "Planning · 2.0s")
  assert.equal(
    stepWords(step("building", 0, 95_000), "Building"),
    "Building · 1m 35s",
    "a span over a minute reads in minutes and seconds",
  )
})

test("a checking marker says what the check found, then the span", () => {
  assert.equal(
    stepWords(step("checking", 0, 500, "failing"), "Checking"),
    "Checking · Checks failed · 0.5s",
  )
  assert.equal(
    stepWords(step("checking", 0, 1_500, "passing"), "Checking"),
    "Checking · Checks passed · 1.5s",
  )
  assert.equal(
    stepWords(step("checking", 0, 1_500, "unchecked"), "Checking"),
    "Checking · Not checked · 1.5s",
  )
})

test("a checking marker that is still open says the flag and no span", () => {
  assert.equal(
    stepWords(step("checking", 0, undefined, "failing"), "Checking"),
    "Checking · Checks failed",
    "a check that has not ended has no span to say",
  )
})
