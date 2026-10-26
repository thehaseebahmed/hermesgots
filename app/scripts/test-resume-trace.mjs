import assert from "node:assert/strict"
import test from "node:test"

import {
  markResume,
  RESUME_STAGES,
  resumeTrace,
  startResumeTrace,
  TRACE_WINDOW_MS,
} from "../src/lib/resume-trace.ts"

test("a mark outside a trace is dropped", () => {
  assert.equal(resumeTrace(), undefined, "nothing has returned yet")
  markResume("sync-start", 1, 1_000)
  assert.equal(resumeTrace(), undefined, "a mark never begins a trace")
})

test("marks are milliseconds since the return, in landing order", () => {
  startResumeTrace(1_000, 10_000)
  markResume("sync-start", 0, 10_400)
  markResume("stream-hello", 0, 10_900)
  markResume("sync-end", 0, 11_250)
  const trace = resumeTrace()
  assert.equal(trace.at, 1_000, "the trace is dated by the return itself")
  assert.deepEqual(trace.stages["sync-start"], [400])
  assert.deepEqual(trace.stages["stream-hello"], [900])
  assert.deepEqual(trace.stages["sync-end"], [1_250])
})

test("a stage that runs twice keeps both marks", () => {
  startResumeTrace(1_000, 10_000)
  markResume("sync-start", 0, 10_400)
  markResume("sync-end", 0, 10_900)
  markResume("sync-start", 0, 12_000)
  markResume("sync-end", 0, 12_300)
  const trace = resumeTrace()
  assert.deepEqual(trace.stages["sync-start"], [400, 2_000], "both syncs are visible")
  assert.deepEqual(trace.stages["sync-end"], [900, 2_300])
})

test("requests count up per stage, and only where they were counted", () => {
  startResumeTrace(1_000, 10_000)
  markResume("chats-merge-end", 1, 10_400)
  markResume("chats-merge-end", 1, 10_500)
  markResume("runs-live-end", 2, 10_600)
  markResume("sync-start", 0, 10_100)
  const trace = resumeTrace()
  assert.equal(trace.requests["chats-merge-end"], 2, "two merge requests")
  assert.equal(trace.requests["runs-live-end"], 2, "one read per server")
  assert.equal(trace.requests["sync-start"], undefined, "an uncounted stage claims no requests")
})

test("the newest return replaces the trace", () => {
  startResumeTrace(1_000, 10_000)
  markResume("sync-start", 0, 10_400)
  startResumeTrace(2_000, 50_000)
  const trace = resumeTrace()
  assert.equal(trace.at, 2_000, "the second return is the trace")
  assert.deepEqual(trace.stages, {}, "the first return's marks are gone")
  markResume("sync-start", 0, 50_300)
  assert.deepEqual(resumeTrace().stages["sync-start"], [300], "measured from the new return")
})

test("a mark past the window is dropped, one at its edge is kept", () => {
  startResumeTrace(1_000, 10_000)
  markResume("runs-live-end", 0, 10_000 + TRACE_WINDOW_MS)
  markResume("runs-live-end", 0, 10_001 + TRACE_WINDOW_MS)
  assert.deepEqual(
    resumeTrace().stages["runs-live-end"],
    [TRACE_WINDOW_MS],
    "the session running on is not still the resume",
  )
})

test("every stage the trace can name", () => {
  assert.deepEqual([...RESUME_STAGES].sort(), [
    "account-docs-end",
    "chats-merge-end",
    "open-chat-caught-up",
    "registry-end",
    "runs-live-end",
    "stream-hello",
    "sync-end",
    "sync-start",
  ])
})
