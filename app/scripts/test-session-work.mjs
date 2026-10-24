/**
 * Where a session stands, as every screen reads it: a chat whose turn has ended is still working
 * while a subagent it dispatched is, which is why the app draws it from the poll it already makes
 * (`runs/live`'s `subagents`) rather than from a read per session — and a question or an approval
 * still comes first, on the thread's pill as in a project session's row.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { sessionGroup, sessionState, threadState } from "../src/lib/session-work.ts"

const session = (facts = {}) => ({
  resolvedAt: undefined,
  discardedAt: undefined,
  planPending: false,
  ...facts,
})

/** A pull request of a session's, live or not, with the checks of its head commit. */
const pr = (state = "open", checks = null) => ({
  repo: "acme/gots",
  number: 7,
  title: "A change",
  state,
  checks,
  url: "https://example.test/7",
  at: 5,
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
