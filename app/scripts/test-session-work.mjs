/**
 * Where a session stands, as every screen reads it: a chat whose turn has ended is still working
 * while a subagent it dispatched is, which is why the app draws it from the poll it already makes
 * (`runs/live`'s `subagents`) rather than from a read per session — and a question or an approval
 * still comes first, on the thread's pill as in a project session's row.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { sessionState, threadState } from "../src/lib/session-work.ts"

const session = (facts = {}) => ({
  resolvedAt: undefined,
  discardedAt: undefined,
  planPending: false,
  ...facts,
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
