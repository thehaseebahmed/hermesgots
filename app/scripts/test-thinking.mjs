import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  appendThinking,
  carrySpans,
  closeRun,
  formatThoughtSpan,
  forgetRuns,
  mergeThoughtRows,
  noteRunThinking,
  runsOf,
  thinkingLabel,
} from "../src/lib/thinking.ts"

const source = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")

test("a turn's thinking is kept in runs, one per stretch between tool calls", () => {
  let runs
  runs = appendThinking(runs, undefined, "Weighing the logs. ", false)
  runs = appendThinking(runs, undefined, "The rotations are the bulk.", false)
  assert.equal(runs.length, 1, "two deltas with no call between them are one run")
  assert.equal(runs[0].text, "Weighing the logs. The rotations are the bulk.")
  assert.equal(runs[0].afterToolId, undefined, "the run before any call sits at the top")

  runs = appendThinking(runs, "call-1", "Listing them, then.", false)
  assert.equal(runs.length, 2, "a call between two stretches starts a new run")
  assert.equal(runs[1].afterToolId, "call-1", "anchored to the call that broke it")
  assert.equal(runs[1].text, "Listing them, then.", "and carries only its own stretch")
  assert.equal(runs[0].text, "Weighing the logs. The rotations are the bulk.", "the first is kept")

  runs = appendThinking(runs, "call-2", "Nothing else will read them.", false)
  assert.deepEqual(
    runs.map((run) => run.afterToolId),
    [undefined, "call-1", "call-2"],
    "in arrival order, each after its own call",
  )
})

test("a whole reasoning block joins the run it continues with a blank line", () => {
  const once = appendThinking(undefined, undefined, "First piece.", true)
  const twice = appendThinking(once, undefined, "Second piece.", true)
  assert.equal(twice.length, 1, "with no call between them, one run")
  assert.equal(twice[0].text, "First piece.\n\nSecond piece.", "blocks are paragraphs")
  const delta = appendThinking(twice, undefined, " and it continues.", false)
  assert.equal(delta[0].text, "First piece.\n\nSecond piece. and it continues.", "a delta joins on")
})

test("the same anchor keeps growing its run, so a steer or an approval breaks nothing", () => {
  let runs = appendThinking(undefined, undefined, "Before the question. ", false)
  // The user answers; the model resumes with no call between.
  runs = appendThinking(runs, undefined, "After the question.", false)
  assert.equal(runs.length, 1, "no tool call started, so the stretch is one run")
  assert.equal(
    runs[0].afterToolId,
    undefined,
    "drawn where it began, not at the top of a second row",
  )
})

test("nothing empty is ever a run", () => {
  assert.deepEqual(appendThinking(undefined, "call-1", "", false), [], "an empty delta adds nothing")
  const runs = appendThinking(undefined, "call-1", "Something.", false)
  assert.deepEqual(
    appendThinking(runs, "call-2", "", true),
    runs,
    "and an empty block does not open a row",
  )
})

test("appendThinking never mutates the array it was given", () => {
  const runs = appendThinking(undefined, undefined, "First.", false)
  const grown = appendThinking(runs, undefined, " More.", false)
  assert.notEqual(grown, runs, "a caller's array is not mutated under it")
  assert.notEqual(grown[0], runs[0], "nor the run object")
  assert.equal(runs[0].text, "First.", "so a flushed row cannot be rewritten in place")
  // An empty piece adds nothing, so there is nothing to copy: the same array comes back untouched.
  assert.equal(appendThinking(runs, undefined, "", false), runs, "and an empty delta copies nothing")
})

test("a row stored before runs folds into one run at the top", () => {
  assert.deepEqual(runsOf({ reasoning: "It thought this." }), [{ text: "It thought this." }])
  assert.deepEqual(runsOf({}), [], "no thinking, no run")
  assert.deepEqual(
    runsOf({
      reasoning: "old",
      reasoningRuns: [{ text: "one" }, { text: "two", afterToolId: "c" }],
    }),
    [{ text: "one" }, { text: "two", afterToolId: "c" }],
    "runs win when a row carries both",
  )
})

test("a run still thinking reads as thinking, span or not", () => {
  assert.equal(thinkingLabel({ thinking: true }), "Thinking…", "an open row says so")
  assert.equal(thinkingLabel({ thinking: true, spanMs: 12_000 }), "Thinking…", "even mid-stretch")
})

test("a run this device measured reads the number, in whole seconds", () => {
  assert.equal(thinkingLabel({ thinking: false, spanMs: 12_000 }), "Thought for 12s")
  assert.equal(thinkingLabel({ thinking: false, spanMs: 63_000 }), "Thought for 1m 3s")
  assert.equal(thinkingLabel({ thinking: false, spanMs: 400 }), "Thought for 1s", "a glance is 1s")
})

test("a run with no span measured reads that it thought it through", () => {
  const label = thinkingLabel({ thinking: false })
  assert.equal(label, "Thought it through", "no number, and no bare Thought")
  assert.doesNotMatch(label, /\d/, "no figure at all")
  assert.doesNotMatch(label, / for$/, 'no stray "for"')
})

test("two thought rows drawn with nothing between them are one row", () => {
  const rows = mergeThoughtRows([
    { text: "Read the parser first.", thinking: false },
    { text: "Its blocks are what matter.", thinking: false },
  ])
  assert.equal(rows.length, 1, "rows that touch are drawn once")
  assert.equal(
    rows[0].row.text,
    "Read the parser first.\n\nIts blocks are what matter.",
    "their words joined as paragraphs",
  )
  assert.equal(rows[0].row.thinking, false, "and nothing of it is still thinking")
  assert.deepEqual(
    { from: rows[0].from, to: rows[0].to },
    { from: 0, to: 1 },
    "the row says the places it covers, so no caller counts where it ends",
  )
})

test("something else drawn between two rows keeps them apart", () => {
  const drawn = [
    { text: "Before the call.", thinking: false },
    null,
    { text: "After the call.", thinking: false },
  ]
  const rows = mergeThoughtRows(drawn)
  assert.equal(rows.length, 2, "a tool group between them splits the row")
  assert.equal(rows[0].row.text, "Before the call.", "each keeps its own words")
  assert.equal(rows[1].row.text, "After the call.", "in the order they arrived")
  assert.deepEqual(
    rows.map((one) => [one.from, one.to]),
    [
      [0, 0],
      [2, 2],
    ],
    "each row answers the place it was drawn and covers nothing the other side of the break",
  )
  assert.equal(rows[0].row, drawn[0], "a stretch nothing merged with is drawn as it was given")
})

test("a row after a break answers the place it was drawn, past what was dropped", () => {
  const rows = mergeThoughtRows([
    { text: "One.", thinking: false },
    { text: "Two.", thinking: false },
    null,
    null,
    { text: "Three.", thinking: false },
    { text: "Four.", thinking: false },
    { text: "Five.", thinking: false },
  ])
  assert.deepEqual(
    rows.map((one) => [one.from, one.to]),
    [
      [0, 1],
      [4, 6],
    ],
    "inclusive places into the list the caller drew from",
  )
})

test("three touching rows join into one, in the order they arrived", () => {
  const rows = mergeThoughtRows([
    { text: "One.", thinking: false },
    { text: "Two.", thinking: false },
    { text: "Three.", thinking: false },
  ])
  assert.equal(rows.length, 1, "a run of touching rows is one row")
  assert.equal(rows[0].row.text, "One.\n\nTwo.\n\nThree.", "none lost, none reordered")
})

test("a merged row adds up the spans this device measured for every stretch", () => {
  const rows = mergeThoughtRows([
    { text: "Weighing it.", thinking: false, spanMs: 5_000 },
    { text: "Then listing it.", thinking: false, spanMs: 7_000 },
  ])
  assert.equal(rows[0].row.spanMs, 12_000, "the spans added")
  assert.equal(thinkingLabel(rows[0].row), "Thought for 12s", "and read as the row's own label")
})

test("one unmeasured stretch leaves a merged row with no number at all", () => {
  const rows = mergeThoughtRows([
    { text: "Weighing it.", thinking: false, spanMs: 5_000 },
    { text: "Then listing it.", thinking: false },
  ])
  assert.equal(rows[0].row.spanMs, undefined, "a stretch nobody watched disqualifies the sum")
  const label = thinkingLabel(rows[0].row)
  assert.equal(label, "Thought it through", "so the row claims no time")
  assert.doesNotMatch(label, /\d/, "not even the half of it this device measured")
})

test("a merged row still thinking reads as thinking", () => {
  const rows = mergeThoughtRows([
    { text: "Weighing it.", thinking: false, spanMs: 5_000 },
    { text: "Then listing it.", thinking: true },
  ])
  assert.equal(rows[0].row.thinking, true, "any stretch still going holds the row open")
  assert.equal(thinkingLabel(rows[0].row), "Thinking…", "and the row says so over any number")
})

test("nothing drawn, or nothing but other things, draws no thought row", () => {
  assert.deepEqual(mergeThoughtRows([]), [], "an empty list draws nothing")
  assert.deepEqual(mergeThoughtRows([null, null]), [], "and other things alone draw no thought row")
})

test("the span formatter is whole seconds, rounded", () => {
  assert.equal(formatThoughtSpan(59_000), "59s")
  assert.equal(formatThoughtSpan(60_000), "1m 0s")
  assert.equal(formatThoughtSpan(61_000), "1m 1s")
  assert.equal(formatThoughtSpan(12_400), "12s")
  assert.equal(formatThoughtSpan(12_600), "13s")
})

test("a run's span is its first delta to its last, not the turn's", () => {
  noteRunThinking("span-run", 0, 1_000)
  noteRunThinking("span-run", 0, 5_000)
  assert.equal(
    closeRun("span-run", 0),
    4_000,
    "its first delta to its last, so the wait after it is not thinking",
  )
  assert.equal(closeRun("span-run", 0), undefined, "a span is measured once")

  noteRunThinking("span-run", 1, 40_000)
  noteRunThinking("span-run", 1, 42_000)
  assert.equal(closeRun("span-run", 1), 2_000, "a later run measures its own stretch")
})

test("a delta that lands after the run closed changes nothing", () => {
  noteRunThinking("late-run", 0, 1_000)
  noteRunThinking("late-run", 0, 5_000)
  assert.equal(closeRun("late-run", 0), 4_000)
  noteRunThinking("late-run", 0, 60_000)
  assert.equal(closeRun("late-run", 0), undefined, "the run keeps the span it measured")
})

test("closing a run nothing watched measures nothing", () => {
  assert.equal(closeRun("never-watched", 0), undefined, "no delta, no span")
  noteRunThinking("watched-elsewhere", 0, 1_000)
  assert.equal(closeRun("watched-elsewhere", 1), undefined, "index 1 was never watched")
  assert.equal(closeRun("watched-elsewhere", 0), 0, "the run it watched keeps what it measured")
})

test("a replacement resets what was measured for that reply", () => {
  noteRunThinking("replaced", 0, 1_000)
  noteRunThinking("replaced", 0, 9_000)
  forgetRuns("replaced")
  assert.equal(closeRun("replaced", 0), undefined, "the rebuilt reply measures afresh")
})

test("a transcript's run keeps the span the same run measured here", () => {
  const local = [
    { text: "one", spanMs: 12_000 },
    { text: "two", afterToolId: "c", spanMs: 3_000 },
  ]
  const fromHost = [{ text: "one" }, { text: "two", afterToolId: "c" }]
  assert.deepEqual(
    carrySpans(fromHost, local),
    [
      { text: "one", spanMs: 12_000 },
      { text: "two", afterToolId: "c", spanMs: 3_000 },
    ],
    "the same run, in the same place, keeps its number",
  )
  assert.deepEqual(
    carrySpans([{ text: "one" }, { text: "rewritten" }], local),
    [{ text: "one", spanMs: 12_000 }, { text: "rewritten" }],
    "a run whose text moved gets no span it did not measure",
  )
  assert.equal(carrySpans(undefined, local), undefined, "nothing from the host, nothing to carry")
  assert.deepEqual(carrySpans([{ text: "one" }], undefined), [{ text: "one" }], "nothing local")
})

test("a transcript's run keeps its span though a row arrived above it", () => {
  const local = [
    { text: "one", spanMs: 12_000 },
    { text: "two", afterToolId: "c", spanMs: 3_000 },
  ]
  assert.deepEqual(
    carrySpans(
      [{ text: "one" }, { text: "another run", afterToolId: "x" }, { text: "two", afterToolId: "c" }],
      local,
    ),
    [
      { text: "one", spanMs: 12_000 },
      { text: "another run", afterToolId: "x" },
      { text: "two", afterToolId: "c", spanMs: 3_000 },
    ],
    "a run is matched by the call it follows and its own words, not by its place",
  )
  assert.deepEqual(
    carrySpans([{ text: "a" }, { text: "b" }], [
      { text: "a", spanMs: 1_000 },
      { text: "b", spanMs: 2_000 },
    ]),
    [
      { text: "a", spanMs: 1_000 },
      { text: "b", spanMs: 2_000 },
    ],
    "two runs with no call between them are matched in the order they arrived",
  )
})

test("thinking.ts still reaches nothing", () => {
  const here = source("../src/lib/thinking.ts")
  assert.doesNotMatch(here, /^[ \t]*(?:import|export)\b.*\bfrom\b/m, "no module is reached")
  assert.doesNotMatch(here, /\bimport\s*\(/, "and nothing is loaded on demand")
  for (const token of ["dexie", "indexeddb", "localstorage", "sessionstorage"]) {
    assert.ok(!here.toLowerCase().includes(token), `nothing here touches ${token}`)
  }
})
