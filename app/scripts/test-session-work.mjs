/**
 * Where a session stands, as every screen reads it: a chat whose turn has ended is still working
 * while a subagent it dispatched is, which is why the app draws it from the poll it already makes
 * (`runs/live`'s `subagents`) rather than from a read per session — and a question or an approval
 * still comes first, on the thread's pill as in a project session's row. For the Code list the
 * ladder starts one rung higher: a session its own run is running claims Working outright, so no
 * wait mark and no pull request's checks reach Waiting for You while it works (ADR 0053).
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  isUnread,
  lastActivityAt,
  rowTone,
  sessionGroup,
  sessionState,
  threadState,
} from "../src/lib/session-work.ts"
import { codeGroupOf } from "../src/lib/item-groups.ts"
import { pr } from "./fixtures/pr.ts"

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

test("a resolved or discarded session reads as it did, unless something of it still runs", () => {
  assert.equal(sessionState(session({ resolvedAt: 5, subagents: 2 })), "resolved")
  assert.equal(sessionState(session({ discardedAt: 5, subagents: 2 })), "discarded")
  assert.equal(
    sessionState(session({ resolvedAt: 5, live: "running" })),
    "working",
    "a run in flight outranks the closed marks too: Closed holds sessions nothing runs for",
  )
})

test("a wake owed by finished subagents reads working until the wake run starts", () => {
  // The window the plugin posts the wake run in: no live turn, no subagent still running, but the
  // host owes the session a run. It must never collapse to idle — that is the stall the user sees.
  assert.equal(sessionState(session({ waking: 1 })), "working")
  assert.equal(sessionState(session({ subagents: 0, waking: 1 })), "working")
  assert.equal(threadState({ waking: 1 }), "working")
  assert.deepEqual(sessionGroup(session(), undefined, undefined, 0, 1), {
    state: "working",
    prTick: false,
  })
  assert.equal(
    group(session(), undefined, undefined, 0, 1),
    "working",
    "the Code list's group reads the same fact",
  )
})

test("a wake owed reads behind what wants the user, like the subagents do", () => {
  assert.equal(sessionState(session({ waking: 1, local: { waiting: true } })), "waiting")
  assert.equal(sessionState(session({ waking: 1, live: "waiting_for_approval" })), "waiting")
  assert.equal(threadState({ waking: 1, waiting: true }), "waiting")
})

test("a closed session stays closed while a wake is owed, as one whose subagents still run", () => {
  assert.equal(sessionState(session({ resolvedAt: 5, waking: 1 })), "resolved")
  assert.equal(sessionState(session({ discardedAt: 5, waking: 1 })), "discarded")
})

test("a wake the host has settled stops the working it owed", () => {
  assert.equal(sessionState(session({ waking: 0 })), "idle", "the wake run is listed; nothing is owed")
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


test("a pull request's checks running or failed wait on the watcher, not the agent", () => {
  assert.deepEqual(sessionGroup(session({ prs: [pr("open", "pending")] })), {
    state: "waiting",
    prTick: true,
  })
  assert.deepEqual(sessionGroup(session({ prs: [pr("open", "failure")] })), {
    state: "waiting",
    prTick: true,
  })
  assert.deepEqual(sessionGroup(session({ prs: [pr("draft", "pending")] })), {
    state: "waiting",
    prTick: true,
  })
  // Beside a run in flight or subagents still working they wait on the watcher beside the agent's
  // work rather than instead of it: that half is the run-in-flight claim, tested below.
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
  assert.deepEqual(sessionGroup(session({ prs: [pr("merged", "failure")] })), {
    state: "idle",
    prTick: false,
  })
})

test("an open question outranks the pull request watching beside it", () => {
  const question = session({ prs: [pr("open", "pending")] })
  assert.deepEqual(sessionGroup(question, "waiting_for_approval", { waiting: true }, 1), {
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


// The Code list's membership, as the screen wires it: the claim read as the group it lands in.
const group = (...claim) => codeGroupOf(sessionGroup(...claim).state)

test("a session with a run in flight is Working, so it never reaches Waiting for You", () => {
  assert.equal(
    group(session({ prs: [pr("open", "pending")] }), "running"),
    "working",
    "a pull request's checks wait on the watcher, not on a session its agent runs",
  )
  assert.equal(
    group(session({ prs: [pr("open", "failure")] }), "running"),
    "working",
    "the same for checks that failed while the agent is still at work",
  )
  assert.equal(
    group(session({ planPending: true }), "running"),
    "working",
    "a plan the host hasn't yet recorded the answer to",
  )
  assert.equal(
    group(session(), "running", { waiting: true }),
    "working",
    "a wait mark from a poll the run has since moved past",
  )
  assert.equal(
    group(session({ prs: [pr("draft", "pending")] }), undefined, undefined, 2),
    "working",
    "subagents the host still runs are the session working",
  )
  assert.equal(
    group(session({ resolvedAt: 5 }), "running"),
    "working",
    "a run in flight is the row's primary claim, closed included",
  )
})

test("a session nothing runs for still waits in Waiting for You, or sits idle or closed", () => {
  assert.equal(group(session(), "waiting_for_approval"), "waiting", "the run is blocked on the user")
  assert.equal(
    group(session(), undefined, { waiting: true }),
    "waiting",
    "the host is silent, and this device sees the approval",
  )
  assert.equal(group(session({ planPending: true })), "waiting", "a plan waits with nothing running")
  assert.equal(
    group(session({ prs: [pr("open", "pending")] })),
    "waiting",
    "checks wait on a session at rest",
  )
  assert.equal(group(session()), "idle", "nothing at all")
  assert.equal(group(session({ resolvedAt: 5 })), "closed", "settled and nothing running")
})


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


test("a session this device has never opened shows no dot", () => {
  const activity = lastActivityAt(session({ updatedAt: 10 }))
  assert.equal(isUnread(activity, undefined), false, "no mark, so nothing to compare")
})

test("the dot shows only while activity is newer than the mark", () => {
  const activity = lastActivityAt(session({ updatedAt: 40, prs: [pr("open", "success", 35)] }))
  assert.equal(isUnread(activity, 50), false, "the thread rendered after everything")
  assert.equal(isUnread(activity, 40), false, "the moment the last activity landed counts as read")
  assert.equal(isUnread(activity, 30), true, "something landed since")
})


test("Discarded and Resolved outrank every pull request for the colour", () => {
  const claim = (state) => ({ state, prTick: false })
  assert.equal(rowTone(session({ discardedAt: 5, prs: [pr("open", "pending")] }), claim("discarded")), "muted")
  assert.equal(rowTone(session({ resolvedAt: 5, prs: [pr("draft", "pending")] }), claim("resolved")), "success")
})

test("anything waiting on the human or on bad checks is yellow", () => {
  assert.equal(rowTone(session(), { state: "waiting", prTick: false }), "warning")
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
