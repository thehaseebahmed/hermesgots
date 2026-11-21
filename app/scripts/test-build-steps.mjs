import assert from "node:assert/strict"
import test from "node:test"

import { drawnSteps, isOpen, liveIndexOf, markersOf, phaseWord, stepWords, turnsInStep, windowsOf } from "../src/lib/build-steps.ts"

/** One visit as the host answers it, mapped by `canvases.ts`'s `buildRowOf`. */
const step = (phase, startedAt, endedAt, flag) => ({
  phase,
  startedAt,
  ...(endedAt === undefined ? {} : { endedAt }),
  ...(flag === undefined ? {} : { flag }),
})

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
    drawnSteps({ phase: "checking" }).map((one) => one.phase),
    ["checking"],
    "a build the record never wrote down still says the phase it is in (I6)",
  )
  assert.deepEqual(
    drawnSteps({ phase: "waiting" }),
    [],
    "but a wait's words are the plan card in the composer's place, so it draws no marker",
  )
  assert.deepEqual(
    drawnSteps({ phase: "failed" }),
    [],
    "and a build that ended with no recorded visits draws none",
  )
  assert.deepEqual(
    drawnSteps({ phase: "building", steps: [visit("planning"), visit("building")] }).map(
      (one) => one.phase,
    ),
    ["planning", "building"],
    "a recorded build draws its own visits, in order, and nothing invented",
  )
})

test("a build the record predates draws the phase it is in, and dates nothing", () => {
  // I6: the host never wrote when this build entered the phase, so the lane draws the marker open
  // and undated — the activity line under it is what says what is happening — rather than inventing
  // a window out of the build's last clock.
  const steps = drawnSteps({ phase: "checking" })
  assert.deepEqual(
    steps,
    [{ phase: "checking" }],
    "the phase alone, and no start the host never recorded",
  )
  assert.deepEqual(windowsOf(steps, { phase: "checking" }), [undefined], "so no window to slice")
  assert.equal(isOpen(steps[0]), true, "open, so there is nothing of it to press")
  assert.equal(stepWords(steps[0]), "Checking", "and it says its phase alone")
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

const TURNS = [{ at: 1_000 }, { at: 2_000 }, { at: 3_000 }]

/** Where each turn lands, as the phase words of the drawn steps that hold it. */
const homesOf = (steps, build, turns) => {
  const windows = windowsOf(steps, build)
  return turns.map((turn) =>
    steps
      .filter((_, at) => turnsInStep([turn], 0, windows[at]).turns.length)
      .map((one) => one.phase),
  )
}

test("a build's drawn steps tile the seconds, each ending where the next begins", () => {
  const steps = markersOf({
    steps: [
      step("planning", 0, 2_000),
      step("waiting", 2_000, 90_000),
      step("building", 90_000, 120_500),
      step("checking", 120_500, 121_000, "failing"),
      step("publishing", 121_000, 121_400),
    ],
  })
  assert.deepEqual(
    windowsOf(steps, { phase: "published" }),
    [
      { start: 0, end: 90 },
      { start: 90, end: 120 },
      { start: 120, end: 122 },
    ],
    "a step ends at the next drawn step's floored start, and the last one a second past the second it closed in",
  )
})

test("a step's sheet keeps the turns that began inside its window", () => {
  assert.deepEqual(
    turnsInStep(TURNS, 0, { start: 2, end: 3 }).turns,
    [TURNS[1]],
    "the window is half-open, so its start's turn is in it and its end's turn is not",
  )
})

test("a turn beginning in the second a phase changed belongs to the step that just began", () => {
  // A row's clock is whole seconds and a visit's is milliseconds, so both edges are floored: a turn
  // stamped inside the same second as an end belongs to the visit that opened at that instant.
  const steps = markersOf({
    steps: [step("planning", 1_000_000, 2_000_400), step("building", 2_000_400, 3_000_000)],
  })
  const windows = windowsOf(steps, { phase: "published" })
  const turn = { at: 2_000_400 }
  assert.deepEqual(turnsInStep([turn], 0, windows[0]).turns, [], "not to the visit that just ended")
  assert.deepEqual(
    turnsInStep([turn], 0, windows[1]).turns,
    [turn],
    "but to the one that began with that second",
  )
})

test("a step's sheet moves the origin to the first turn it keeps", () => {
  const kept = turnsInStep(TURNS, 7, { start: 2, end: 3 })
  assert.equal(
    kept.origin,
    8,
    "a kept turn keeps the place it had, which is what its message id is counted from",
  )
  assert.equal(turnsInStep(TURNS, 7, { start: 9, end: 10 }).origin, 7)
})

test("a window with no end keeps every turn from its start on, and a bounded one drops an undated turn", () => {
  const turns = [{ at: 2_000 }, {}, { at: 4_000 }]
  assert.deepEqual(
    turnsInStep(turns, 0, { start: 2, end: Infinity }).turns,
    turns,
    "a visit the build has not left has no end to bound it",
  )
  assert.deepEqual(
    turnsInStep(turns, 0, { start: 2, end: 3 }).turns,
    [turns[0]],
    "a bounded visit leaves out a turn nothing can place",
  )
})

test("a sub-second visit's second is a window, and its turn does not vanish", () => {
  // A real build's check can run in under a second, and its visit then floors to a window one second
  // wide at its end: the turn stamped in that second is the check's own, not nobody's.
  const steps = markersOf({
    steps: [
      step("planning", 0, 2_000),
      step("building", 2_000, 90_000),
      step("checking", 90_000, 90_400, "passing"),
      step("publishing", 90_400, 90_420),
    ],
  })
  assert.deepEqual(
    homesOf(steps, { phase: "published" }, [{ at: 90_000 }]),
    [["checking"]],
    "the 400ms check holds the turn stamped in the second it ran in",
  )
})

test("the last drawn step keeps the second the build closed in, and stays open while it works", () => {
  const closed = [step("planning", 0, 2_000), step("checking", 120_500, 121_000, "failing")]
  const closing = { at: 121_000 }
  assert.deepEqual(
    windowsOf(markersOf({ steps: closed }), { phase: "published" })[1],
    { start: 120, end: 122 },
    "the last drawn step holds the second it began in and the one it closed in, since publishing after it is not drawn",
  )
  assert.deepEqual(
    homesOf(markersOf({ steps: closed }), { phase: "published" }, [closing]),
    [["checking"]],
    "so the turn stamped as the build closed lands in it rather than nowhere",
  )
  const working = markersOf({ steps: [step("planning", 0, 2_000), step("checking", 120_500)] })
  assert.equal(
    windowsOf(working, { phase: "publishing" })[1].end,
    Infinity,
    "a build at work leaves its last drawn step open, so nothing stamped after it falls between two",
  )
})

test("a build whose phases all fall in one second still lands every turn in one step", () => {
  // A real plugin run's visits can all be inside one whole second, as the probe of "a build whose
  // checks could not run" showed. Every one of them floors to the same second; the last drawn step
  // is what holds it, so the turns are read rather than lost.
  const steps = markersOf({
    steps: [
      step("planning", 1_795_269_103_975, 1_795_269_103_984),
      step("building", 1_795_269_103_984, 1_795_269_103_988),
      step("checking", 1_795_269_103_988, 1_795_269_103_990, "unchecked"),
      step("publishing", 1_795_269_103_990, 1_795_269_103_991),
    ],
  })
  const turns = [{ at: 1_795_269_103_000 }, { at: 1_795_269_103_000 }]
  assert.deepEqual(
    windowsOf(steps, { phase: "published" }).map((one) => [one.start, one.end]),
    [
      [1_795_269_103, 1_795_269_103],
      [1_795_269_103, 1_795_269_103],
      [1_795_269_103, 1_795_269_104],
    ],
    "the visits share one second, and only the last can hold it",
  )
  assert.deepEqual(
    homesOf(steps, { phase: "published" }, turns),
    [["checking"], ["checking"]],
    "every dated turn lands in exactly one step",
  )
})

test("a build publishing leaves no turn between its last drawn step and its reply", () => {
  const steps = markersOf({
    steps: [
      step("planning", 0, 2_000),
      step("building", 2_000, 90_000),
      step("checking", 90_000, 91_000, "passing"),
      step("publishing", 91_000),
    ],
  })
  assert.deepEqual(
    homesOf(steps, { phase: "publishing" }, [{ at: 91_000 }]),
    [["checking"]],
    "a turn stamped as the build publishes reads in the last step that did work",
  )
})
