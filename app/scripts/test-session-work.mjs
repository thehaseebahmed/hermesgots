/**
 * Where a session stands, as every screen reads it: a chat whose turn has ended is still working
 * while a subagent it dispatched is, which is why the app draws it from the poll it already makes
 * (`runs/live`'s `subagents`) rather than from a read per session — and a question or an approval
 * still comes first, on the thread's pill as in a project session's row.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  lastActivityAt,
  rowTone,
  sessionGroup,
  sessionState,
  threadState,
} from "../src/lib/session-work.ts"

const session = (facts = {}) => ({
  resolvedAt: undefined,
  discardedAt: undefined,
  planPending: false,
  ...facts,
})

/** A pull request of a session's, live or not, with the checks of its head commit. */
const pr = (state = "open", checks = null, at = 5) => ({
  repo: "acme/gots",
  number: 7,
  title: "A change",
  state,
  checks,
  url: "https://example.test/7",
  at,
})

test("a live subagent with no live turn reads working", () => {
  assert.equal(sessionState(session({ subagents: 1 })), "working")
  assert.equal(sessionState(session({ local: { streaming: false }, subagents: 2 })), "working")
})

test("nothing at work is idle", () => {
  assert.equal(sessionState(session()), "idle")
  assert.equal(sessionState(session({ subagents: 0 })), "idle")
})

test("a turn in flight is still working, with or without subagents", () => {
  assert.equal(sessionState(session({ live: "running" })), "working")
  assert.equal(sessionState(session({ local: { streaming: true } })), "working")
})

test("a question or an approval outranks the subagents working beside it", () => {
  assert.equal(sessionState(session({ live: "waiting_for_approval", subagents: 1 })), "waiting")
  assert.equal(sessionState(session({ local: { waiting: true }, subagents: 1 })), "waiting")
  assert.equal(sessionState(session({ planPending: true, subagents: 1 })), "waiting")
})

test("a resolved or discarded session reads as it did", () => {
  assert.equal(sessionState(session({ resolvedAt: 5, live: "running", subagents: 2 })), "resolved")
  assert.equal(sessionState(session({ discardedAt: 5, subagents: 2 })), "discarded")
})

test("a thread's pill reads working while its subagents run", () => {
  assert.equal(threadState({ subagents: 1 }), "working")
  assert.equal(threadState({ streaming: true }), "working")
  assert.equal(threadState({}), "idle")
})

test("a thread waiting on the user keeps waiting over its subagents", () => {
  assert.equal(threadState({ waiting: true, subagents: 2 }), "waiting")
})

test("a failed reply reads failed, unless something still works", () => {
  assert.equal(threadState({ failed: true }), "failed")
  assert.equal(threadState({ failed: true, subagents: 1 }), "working")
})

// The Code row's claim: which group the session lands in, told by `{ state, prTick }` —
// state picks the group (`codeGroupOf`), prTick is the pull request's arrow.

test("a pull request's checks running or failed wait on the watcher, not the agent", () => {
  assert.deepEqual(sessionGroup(session({ prs: [pr("open", "pending")] })), {
    state: "waiting",
    prTick: true,
  })
  assert.deepEqual(sessionGroup(session({ prs: [pr("open", "failure")] })), {
    state: "waiting",
    prTick: true,
  })
  // They used to read `working`, and they lose to nothing short of closed: a turn runs beside them.
  assert.deepEqual(sessionGroup(session({ prs: [pr("open", "pending")] }), "running"), {
    state: "waiting",
    prTick: true,
  })
  assert.deepEqual(sessionGroup(session({ prs: [pr("draft", "pending")] }), undefined, undefined, 2), {
    state: "waiting",
    prTick: true,
  })
})

test("checks that have settled stop waiting — unless the pull request still does", () => {
  assert.deepEqual(sessionGroup(session({ prs: [pr("open", "success")] })), {
    state: "waiting",
    prTick: true,
  })
  assert.deepEqual(sessionGroup(session({ prs: [pr("draft", "success")] })), {
    state: "waiting",
    prTick: true,
  })
  // Finished pull requests claim nothing, however their checks ended.
  assert.deepEqual(sessionGroup(session({ prs: [pr("merged", "failure")] })), {
    state: "idle",
    prTick: false,
  })
})

test("an open question outranks the pull request watching beside it", () => {
  const question = session({ prs: [pr("open", "pending")] })
  assert.deepEqual(sessionGroup(question, "running", { waiting: true }, 1), {
    state: "waiting",
    prTick: false,
  })
  assert.deepEqual(sessionGroup(question, undefined, { waiting: true }), {
    state: "waiting",
    prTick: false,
  })
})

test("an agent running with no wait is working, whatever its pull requests finished", () => {
  assert.deepEqual(sessionGroup(session({ prs: [pr("open", "success")] }), "running"), {
    state: "working",
    prTick: false,
  })
  assert.deepEqual(sessionGroup(session({ prs: [pr("merged", null)] }), undefined, undefined, 1), {
    state: "working",
    prTick: false,
  })
})

test("a closed session stays closed, its pull requests claiming nothing", () => {
  assert.deepEqual(sessionGroup(session({ resolvedAt: 5, prs: [pr("open", "pending")] })), {
    state: "resolved",
    prTick: false,
  })
  assert.deepEqual(sessionGroup(session({ discardedAt: 5, prs: [pr("open", "success")] })), {
    state: "discarded",
    prTick: false,
  })
})

test("a session nothing runs and no pull request opens is idle", () => {
  assert.deepEqual(sessionGroup(session()), { state: "idle", prTick: false })
  assert.deepEqual(sessionGroup(session({ prs: [pr("merged", null)] })), {
    state: "idle",
    prTick: false,
  })
})

// The row's trailing time: the newest moment the session has seen, whichever kind it is.

test("a row's time is the newest moment, not just the turn's", () => {
  assert.equal(lastActivityAt(session({ updatedAt: 10 })), 10, "the turn's end, alone")
  assert.equal(
    lastActivityAt(session({ updatedAt: 10, prs: [pr("open", "success", 25)] })),
    25,
    "a pull request moving after the turn carries the time",
  )
  assert.equal(
    lastActivityAt(session({ updatedAt: 30, prs: [pr("open", "pending", 25)] })),
    30,
    "an older pull request never drags it back",
  )
  assert.equal(
    lastActivityAt(session({ updatedAt: 10, prs: [pr("open", "success", 25), pr("merged", null, 40)] })),
    40,
    "the newest of several pull requests",
  )
})

test("a resolve or discard carries the time when it is the newest", () => {
  assert.equal(
    lastActivityAt(session({ updatedAt: 10, resolvedAt: 40, prs: [pr("open", "success", 25)] })),
    40,
    "resolved after everything else",
  )
  assert.equal(lastActivityAt(session({ updatedAt: 10, discardedAt: 40 })), 40, "discarded after the turn")
  assert.equal(
    lastActivityAt(session({ updatedAt: 30, resolvedAt: 5, prs: [pr("merged", null, 25)] })),
    30,
    "an older resolve never drags it back",
  )
})

// The icon's colour: what the round icon behind the glyph wears, top rule winning.

test("Discarded and Resolved outrank every pull request for the colour", () => {
  const claim = (state) => ({ state, prTick: false })
  assert.equal(rowTone(session({ discardedAt: 5, prs: [pr("open", "pending")] }), claim("discarded")), "muted")
  assert.equal(rowTone(session({ resolvedAt: 5, prs: [pr("draft", "pending")] }), claim("resolved")), "success")
})

test("anything waiting on the human or on bad checks is yellow", () => {
  // On the human: the waiting claim without the pull request's arrow.
  assert.equal(rowTone(session(), { state: "waiting", prTick: false }), "warning")
  // On checks running or failed, whichever live pull request carries them.
  assert.equal(
    rowTone(session({ prs: [pr("open", "pending")] }), { state: "waiting", prTick: true }),
    "warning",
  )
  assert.equal(
    rowTone(session({ prs: [pr("draft", "failure")] }), { state: "waiting", prTick: true }),
    "warning",
  )
})

test("a draft pull request wears grey unless it owes an answer or its checks", () => {
  const draft = session({ prs: [pr("draft", "success")] })
  assert.equal(rowTone(draft, { state: "waiting", prTick: true }), "muted", "settled, awaiting review")
  assert.equal(rowTone(draft, { state: "working", prTick: false }), "muted", "the agent runs beside it")
  assert.equal(rowTone(draft, { state: "waiting", prTick: false }), "warning", "an open question still wins")
  assert.equal(
    rowTone(session({ prs: [pr("draft", "pending")] }), { state: "waiting", prTick: true }),
    "warning",
    "checks running still win",
  )
})

test("an open pull request needing nothing is green whatever else the session does", () => {
  const open = session({ prs: [pr("open", "success")] })
  assert.equal(rowTone(open, { state: "waiting", prTick: true }), "success", "waiting for its merge")
  assert.equal(rowTone(open, { state: "working", prTick: false }), "success", "the agent runs beside it")
  assert.equal(rowTone(open, { state: "idle", prTick: false }), "success", "idle with the pull request open")
})

test("everything at rest is grey, finished pull requests included", () => {
  assert.equal(rowTone(session(), { state: "idle", prTick: false }), "muted", "nothing happens")
  assert.equal(rowTone(session(), { state: "working", prTick: false }), "muted", "the agent runs")
  assert.equal(
    rowTone(session({ prs: [pr("merged", "success"), pr("closed", "failure")] }), {
      state: "idle",
      prTick: false,
    }),
    "muted",
    "merged and closed wait on nothing, their checks or not",
  )
})
