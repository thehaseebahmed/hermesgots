import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  appendThinking,
  carrySpans,
  closeRun,
  countHome,
  formatThoughtSpan,
  forgetRuns,
  mergeThoughtRows,
  noteRunThinking,
  placeThinking,
  runsOf,
  statusLineOf,
  thinkingLabel,
  thinkingRows,
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
  assert.deepEqual(
    appendThinking(undefined, "call-1", "", false),
    [],
    "an empty delta adds nothing",
  )
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
  assert.equal(
    appendThinking(runs, undefined, "", false),
    runs,
    "and an empty delta copies nothing",
  )
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

test("the rows a reply draws are its runs, marked where the turn still thinks", () => {
  const [row] = thinkingRows({
    content: "",
    status: "streaming",
    reasoningRuns: [{ text: "Weighing it." }],
  })
  assert.equal(row.thinking, true, "the reply's newest run has no words still arriving")
  assert.equal(row.key, "run-0", "keyed by its place, as every drawn row is")

  const afterCall = thinkingRows({
    content: "Text.",
    status: "streaming",
    reasoningRuns: [{ text: "Quiet.", afterToolId: "c1" }],
    tools: [{ toolCallId: "c1", status: "completed", contentOffset: 5 }],
  })
  assert.equal(afterCall.length, 1, "the run after the call is the row that says its quiet")
  assert.equal(afterCall[0].thinking, true, "so it turns its loader")

  const done = thinkingRows({
    content: "Text.",
    status: "done",
    reasoningRuns: [{ text: "Weighing it." }],
  })
  assert.equal(done[0].thinking, false, "a reply done thinking draws its run without the loader")
})

test("a turn with no word of thinking draws no row at all", () => {
  assert.deepEqual(
    thinkingRows({ content: "", status: "streaming" }),
    [],
    "the turn works but its model has said nothing: the status line says so, not an empty row",
  )
  assert.deepEqual(
    thinkingRows({
      content: "Text.",
      status: "streaming",
      tools: [{ toolCallId: "c1", status: "completed", contentOffset: 5 }],
    }),
    [],
    "the quiet behind a call draws no row either, so nothing stands below the call it is about",
  )
  assert.deepEqual(
    thinkingRows({ content: "", status: "streaming", waiting: true }),
    [],
    "a turn waiting on the reader is the footer's line to say, not the row's",
  )
  assert.deepEqual(
    thinkingRows({ content: "", status: "streaming", statusText: "Context is compacting…" }),
    [],
    "the host's own status names what is happening, so no row joins it",
  )
  assert.deepEqual(
    thinkingRows({
      content: "",
      status: "streaming",
      tools: [{ toolCallId: "c1", status: "running", contentOffset: 0 }],
    }),
    [],
    "a call still running is its own row's to say",
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
      [
        { text: "one" },
        { text: "another run", afterToolId: "x" },
        { text: "two", afterToolId: "c" },
      ],
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
    carrySpans(
      [{ text: "a" }, { text: "b" }],
      [
        { text: "a", spanMs: 1_000 },
        { text: "b", spanMs: 2_000 },
      ],
    ),
    [
      { text: "a", spanMs: 1_000 },
      { text: "b", spanMs: 2_000 },
    ],
    "two runs with no call between them are matched in the order they arrived",
  )
})

test("the three rows a working reply ends on stand thought, tools, status", () => {
  const row = (run) => ({ kind: "thinking", ...run })
  const text = (at) => ({ kind: "text", at, text: `words ${at}` })
  const call = (...ids) => ({ kind: "tools", tools: ids.map((id) => ({ toolCallId: id })) })
  const card = (id) => ({ kind: "agent", tool: { toolCallId: id } })
  const kinds = (parts) => parts.map((one) => one.kind)

  assert.deepEqual(
    placeThinking([text(0), call("c1")], [], row),
    [text(0), call("c1")],
    "a turn with no word of thinking draws no row, so the foot is its text and its call",
  )

  assert.deepEqual(
    kinds(
      placeThinking(
        [text(0), call("c1")],
        [row({ key: "r", text: "why", thinking: true, afterToolId: "c1" })],
        row,
      ),
    ),
    ["text", "thinking", "tools"],
    "the thought row stands above the call it led into, never below it",
  )

  const runs = [
    { key: "r1", text: "first", thinking: false, afterToolId: "c1" },
    { key: "r2", text: "second", thinking: true, afterToolId: "c2" },
  ]
  assert.deepEqual(
    kinds(placeThinking([text(0), call("c1"), text(1), call("c2")], runs, row)),
    ["text", "thinking", "tools", "text", "thinking", "tools"],
    "the order is per cluster, and nothing already placed moves",
  )

  assert.deepEqual(
    kinds(
      placeThinking(
        [text(0), call("c1", "c2")],
        [row({ key: "r", text: "why", thinking: false, afterToolId: "c2" })],
        row,
      ),
    ),
    ["text", "thinking", "tools"],
    "a call the reply grouped with another is still found, and its row stands above the whole group",
  )

  assert.deepEqual(
    kinds(
      placeThinking(
        [card("a1"), text(0)],
        [row({ key: "r", text: "why", thinking: false, afterToolId: "a1" })],
        row,
      ),
    ),
    ["agent", "thinking", "text"],
    "a stretch that follows a card stays behind it, not above it",
  )

  assert.deepEqual(
    kinds(placeThinking([text(0)], [row({ key: "r", text: "top", thinking: false })], row)),
    ["thinking", "text"],
    "a run at the top of a reply opens it",
  )
})

test("the foot of a reply says one thing: its line, its count, or nothing", () => {
  const working = { status: "streaming", activity: "Writing…" }

  assert.deepEqual(
    statusLineOf({ ...working, thinks: true }),
    undefined,
    "a thought row above already says the turn is thinking, so no line joins it",
  )
  assert.deepEqual(
    statusLineOf({ ...working, runningCall: true }),
    undefined,
    "a call running is its own row's to say",
  )
  assert.deepEqual(
    statusLineOf({ ...working, waiting: true, activity: "Waiting for your answer" }),
    { text: "Waiting for your answer", count: "none", countLoader: false },
    "the wait words take the busy words' place, and keep the line live",
  )
  assert.deepEqual(
    statusLineOf({ ...working, count: 2, countShown: true }),
    { text: "Writing…", count: "suffix", countLoader: false },
    "the count rides the words, and the line's one loader serves both",
  )
  assert.deepEqual(
    statusLineOf({ status: "streaming", runningCall: true, count: 2, countShown: true }),
    { count: "alone", countLoader: false },
    "with a call running the line says only the count, and turns no second loader",
  )
  assert.deepEqual(
    statusLineOf({ status: "done", count: 2, countShown: true }),
    { count: "alone", countLoader: true },
    "a finished turn's count is the line's only words, and its loader turns in the blue",
  )
  assert.deepEqual(
    statusLineOf({ status: "done", count: 2, countShown: false }),
    undefined,
    "a finished reply with nothing at work draws no line at all",
  )
  assert.deepEqual(
    statusLineOf({ status: "done", count: 0, countShown: true }),
    undefined,
    "and a count of nothing is no count",
  )
  assert.equal(
    statusLineOf({ status: "error", activity: "Writing…" }),
    undefined,
    "a reply that failed wears its error where the line would stand",
  )
  assert.equal(
    statusLineOf({ status: "stopped", activity: "Writing…" }),
    undefined,
    'and a stopped one wears "Stopped" there',
  )
})

test("the thread draws the count of subagents at work once, and never on two rows", () => {
  assert.equal(
    countHome({ running: 0, catching: true, drawsLine: true }),
    "none",
    "no subagent at work is no count, whatever else the thread is doing",
  )
  assert.equal(
    countHome({ running: 1, catching: true, drawsLine: true }),
    "catching",
    "while the thread catches up its one line is the catch-up line, so the count is that line's",
  )
  assert.equal(
    countHome({ running: 1, catching: true, drawsLine: false }),
    "catching",
    "and it stays there whether or not the last reply would draw a line of its own",
  )
  assert.equal(
    countHome({ running: 1, catching: false, drawsLine: true }),
    "reply",
    "with no catch-up line the last reply's own line holds it",
  )
  assert.equal(
    countHome({ running: 1, catching: false, drawsLine: false }),
    "foot",
    "and where that reply draws no line the thread's foot takes it",
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
