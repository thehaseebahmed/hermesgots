import assert from "node:assert/strict"
import test from "node:test"

import {
  MARKS_PER_STAGE,
  markResume,
  RESUME_STAGES,
  resumeTrace,
  startResumeTrace,
  TRACE_WINDOW_MS,
} from "../src/lib/resume-trace.ts"

test("a mark outside a trace is dropped", () => {
  assert.equal(resumeTrace(), undefined, "nothing has returned yet")
  markResume("sync-start", { requests: 1, now: 1_000 })
  assert.equal(resumeTrace(), undefined, "a mark never begins a trace")
})

test("marks are milliseconds since the return, in landing order", () => {
  startResumeTrace({ at: 1_000, started: 10_000 })
  markResume("sync-start", { now: 10_400 })
  markResume("stream-hello", { now: 10_900 })
  markResume("sync-end", { now: 11_250 })
  const trace = resumeTrace()
  assert.equal(trace.at, 1_000, "the trace is dated by the return itself")
  assert.deepEqual(trace.stages["sync-start"], [400])
  assert.deepEqual(trace.stages["stream-hello"], [900])
  assert.deepEqual(trace.stages["sync-end"], [1_250])
})

test("a stage that runs twice keeps both marks", () => {
  startResumeTrace({ at: 1_000, started: 10_000 })
  markResume("sync-start", { now: 10_400 })
  markResume("sync-end", { now: 10_900 })
  markResume("sync-start", { now: 12_000 })
  markResume("sync-end", { now: 12_300 })
  const trace = resumeTrace()
  assert.deepEqual(trace.stages["sync-start"], [400, 2_000], "both syncs are visible")
  assert.deepEqual(trace.stages["sync-end"], [900, 2_300])
})

test("requests count up per stage, and only where they were counted", () => {
  startResumeTrace({ at: 1_000, started: 10_000 })
  markResume("chats-merge-end", { requests: 1, now: 10_400 })
  markResume("chats-merge-end", { requests: 1, now: 10_500 })
  markResume("runs-live-end", { requests: 2, now: 10_600 })
  markResume("sync-start", { now: 10_100 })
  const trace = resumeTrace()
  assert.equal(trace.requests["chats-merge-end"], 2, "two merge requests")
  assert.equal(trace.requests["runs-live-end"], 2, "one read per server")
  assert.equal(trace.requests["sync-start"], undefined, "an uncounted stage claims no requests")
})

test("the newest return replaces the trace", () => {
  startResumeTrace({ at: 1_000, started: 10_000 })
  markResume("sync-start", { now: 10_400 })
  startResumeTrace({ at: 2_000, started: 50_000 })
  const trace = resumeTrace()
  assert.equal(trace.at, 2_000, "the second return is the trace")
  assert.deepEqual(trace.stages, {}, "the first return's marks are gone")
  markResume("sync-start", { now: 50_300 })
  assert.deepEqual(resumeTrace().stages["sync-start"], [300], "measured from the new return")
})

test("a mark past the window is dropped, one at its edge is kept", () => {
  startResumeTrace({ at: 1_000, started: 10_000 })
  markResume("runs-live-end", { now: 10_000 + TRACE_WINDOW_MS })
  markResume("runs-live-end", { now: 10_001 + TRACE_WINDOW_MS })
  assert.deepEqual(
    resumeTrace().stages["runs-live-end"],
    [TRACE_WINDOW_MS],
    "the session running on is not still the resume",
  )
})

test("a stage keeps a bounded number of offsets", () => {
  startResumeTrace({ at: 1_000, started: 10_000 })
  for (let mark = 1; mark <= MARKS_PER_STAGE + 4; mark++) {
    markResume("runs-live-end", { now: 10_000 + mark * 100 })
  }
  assert.equal(
    resumeTrace().stages["runs-live-end"].length,
    MARKS_PER_STAGE,
    "a poll every 10s of a window cannot grow the dump",
  )
})

test("a trace read is a copy later marks leave alone", () => {
  startResumeTrace({ at: 1_000, started: 10_000 })
  markResume("sync-start", { now: 10_100 })
  const read = resumeTrace()
  markResume("sync-start", { now: 10_900 })
  assert.deepEqual(read.stages["sync-start"], [100], "the read is what it was when it was read")
  assert.deepEqual(resumeTrace().stages["sync-start"], [100, 900])
})

test("a mark of every stage lands under its own name", () => {
  startResumeTrace({ at: 1_000, started: 10_000 })
  for (const stage of RESUME_STAGES) markResume(stage, { now: 10_500 })
  assert.deepEqual(
    Object.keys(resumeTrace().stages).sort(),
    [...RESUME_STAGES].sort(),
    "the list is the contract the dump picks by",
  )
})
