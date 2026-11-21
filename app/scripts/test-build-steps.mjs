/**
 * The lane's steps as a pure rule (G2, G6): which of a build's visits draw a marker, whether one is
 * still open, and the words its marker says. A build's record holds every phase it visited, but the
 * lane draws only the visits that did work — Waiting's words are the composer's plan card, and a
 * Publishing visit holds no turns — so a build that planned, waited, built, checked, built again,
 * checked again and published draws five markers, in the order they happened.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { drawnSteps, isOpen, liveIndexOf, markersOf, phaseWord, stepWords, turnsInStep } from "../src/lib/build-steps.ts"

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
  assert.equal(stepWords(step("building", 5_000)), "Building")
})

test("a phase this build's app does not know still says a word", () => {
  assert.equal(phaseWord("auditing"), "Working", "an unknown phase is not drawn as an empty marker")
  assert.equal(phaseWord("checking"), "Checking")
})

test("a closed marker says its phase and the span it took", () => {
  assert.equal(stepWords(step("planning", 0, 2_000)), "Planning · 2.0s")
  assert.equal(
    stepWords(step("building", 0, 95_000)),
    "Building · 1m 35s",
    "a span over a minute reads in minutes and seconds",
  )
})

test("a checking marker says what the check found, then the span", () => {
  assert.equal(
    stepWords(step("checking", 0, 500, "failing")),
    "Checking · Checks failed · 0.5s",
  )
  assert.equal(
    stepWords(step("checking", 0, 1_500, "passing")),
    "Checking · Checks passed · 1.5s",
  )
  assert.equal(
    stepWords(step("checking", 0, 1_500, "unchecked")),
    "Checking · Not checked · 1.5s",
  )
})

test("a checking marker that is still open says the flag and no span", () => {
  assert.equal(
    stepWords(step("checking", 0, undefined, "failing")),
    "Checking · Checks failed",
    "a check that has not ended has no span to say",
  )
})

test("a build at work in a phase it does not draw says that phase, and one that ended says nothing", () => {
  const visit = (phase) => ({ phase, startedAt: 0 })
  assert.deepEqual(
    drawnSteps({ phase: "checking", at: 7 }).map((one) => one.phase),
    ["checking"],
    "a build the record never wrote down still says the phase it is in (I6)",
  )
  assert.deepEqual(
    drawnSteps({ phase: "waiting", at: 7 }),
    [],
    "but a wait's words are the plan card in the composer's place, so it draws no marker",
  )
  assert.deepEqual(
    drawnSteps({ phase: "failed", at: 7 }),
    [],
    "and a build that ended with no recorded visits draws none",
  )
  assert.deepEqual(
    drawnSteps({ phase: "building", at: 7, steps: [visit("planning"), visit("building")] }).map(
      (one) => one.phase,
    ),
    ["planning", "building"],
    "a recorded build draws its own visits, in order, and nothing invented",
  )
})

test("only a visit the build has not left is drawn live", () => {
  assert.equal(
    liveIndexOf([step("planning", 0, 2_000), step("building", 2_000)]),
    1,
    "the open visit is the live one",
  )
  assert.equal(
    liveIndexOf([step("planning", 0, 2_000)]),
    -1,
    "a build waiting on its plan draws the visit behind it, and left that one",
  )
  assert.equal(liveIndexOf([]), -1, "a block with no marker draws none live")
})

/** Three turns, one to a visit, in the milliseconds a row's whole seconds become. */
const TURNS = [{ at: 1_000_000 }, { at: 2_000_000 }, { at: 3_000_000 }]

test("a step's sheet keeps the turns that began inside its window", () => {
  assert.deepEqual(
    turnsInStep(TURNS, 0, { startedAt: 2_000_000, endedAt: 3_000_000 }).turns,
    [TURNS[1]],
    "the window is half-open, so its start's turn is in it and its end's turn is not",
  )
})

test("a turn beginning in the second a phase changed belongs to the step that just began", () => {
  // A row's clock is whole seconds and a visit's is milliseconds, so both edges are floored: a turn
  // stamped inside the same second as an end belongs to the visit that opened at that instant.
  const turn = { at: 2_000_400 }
  assert.deepEqual(
    turnsInStep([turn], 0, { startedAt: 1_000_000, endedAt: 2_000_400 }).turns,
    [],
    "not to the visit that just ended",
  )
  assert.deepEqual(
    turnsInStep([turn], 0, { startedAt: 2_000_400, endedAt: 3_000_000 }).turns,
    [turn],
    "but to the one that began with that second",
  )
})

test("a step's sheet moves the origin to the first turn it keeps", () => {
  const kept = turnsInStep(TURNS, 7, { startedAt: 2_000_000, endedAt: 3_000_000 })
  assert.equal(
    kept.origin,
    8,
    "a kept turn keeps the place it had, which is what its message id is counted from",
  )
  assert.equal(turnsInStep(TURNS, 7, { startedAt: 9_000_000, endedAt: 10_000_000 }).origin, 7)
})

test("a window with no end keeps every turn from its start on, and a bounded one drops an undated turn", () => {
  const turns = [{ at: 2_000_000 }, {}, { at: 4_000_000 }]
  assert.deepEqual(
    turnsInStep(turns, 0, { startedAt: 2_000_000 }).turns,
    turns,
    "a visit the build has not left has no end to bound it",
  )
  assert.deepEqual(
    turnsInStep(turns, 0, { startedAt: 2_000_000, endedAt: 3_000_000 }).turns,
    [turns[0]],
    "a bounded visit leaves out a turn nothing can place",
  )
})
