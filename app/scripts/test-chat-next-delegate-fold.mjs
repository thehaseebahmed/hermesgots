/**
 * Delegation, as Hermes 0.22.5 writes it (`fixtures/delegate.*`, recorded from a real host): the
 * `delegate_task` call returns at once ("dispatched"), the turn ends, and when the child finishes
 * Hermes writes two delivery rows — `async_delegation_complete`, then `internal_notification`
 * naming the child — and runs a second reply, the wake turn, which has no message of the user's.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { cardsOf, goalsOf } from "../src/chat-next/agents.ts"
import { foldTurns } from "../src/chat-next/fold.ts"

const recorded = (name) =>
  JSON.parse(readFileSync(new URL(`../src/chat-next/fixtures/${name}`, import.meta.url), "utf8"))

const parent = recorded("delegate.parent.transcript.json").data
const done = recorded("delegate.agents.done.json").agents
const running = recorded("delegate.agents.running.json").agents
const CHILD = "20261028_151415_fe71dd"

const row = (id, role, content, extra = {}) => ({ id, role, content, ...extra })
const batch = (id) =>
  row(id, "user", `[ASYNC DELEGATION BATCH COMPLETE — deleg_${id}]\nresults`, {
    display_kind: "async_delegation_complete",
  })
const notice = (id, child) =>
  row(id, "user", `[ASYNC DELEGATION COMPLETE — ${child}]\nresult`, {
    display_kind: "internal_notification",
  })
const stop = (id, text) => row(id, "assistant", text, { finish_reason: "stop" })

test("a delegated turn and the wake turn that follows it fold into two turns", () => {
  const turns = foldTurns(parent)
  assert.equal(turns.length, 2)
  assert.match(turns[0].user, /^Use the delegate_task tool/)
  assert.deepEqual(
    turns[0].parts.map((part) => part.kind),
    ["tools", "text"],
  )
  assert.match(turns[0].parts[1].text, /^Delegated/)
  assert.equal(turns[0].done, true, "the turn ended while the child worked")
})

test("the wake turn has no message of the user's, and draws only its own reply", () => {
  const wake = foldTurns(parent)[1]
  assert.equal(wake.wake, true)
  assert.equal(wake.user, "")
  assert.deepEqual(
    wake.parts.map((part) => part.kind),
    ["text"],
  )
  assert.match(wake.parts[0].text, /^Delegated and completed/)
  assert.equal(wake.done, true)
})

test("the wake turn names the child it reports, so a device knows its result is in", () => {
  assert.deepEqual(foldTurns(parent)[1].delivered, [CHILD])
  assert.deepEqual(foldTurns(parent)[0].delivered, [])
})

test("a user row Hermes marked internal_notification is still a user's turn when it is their text", () => {
  // The recording's own first row: the user's prompt, carrying that display_kind.
  assert.equal(parent[0].display_kind, "internal_notification")
  assert.match(foldTurns(parent)[0].user, /^Use the delegate_task tool/)
})

test("the delegate_task call keeps its arguments and its dispatched result", () => {
  const [call] = foldTurns(parent)[0].parts[0].calls
  assert.equal(call.name, "delegate_task")
  assert.match(call.arguments, /"tasks"/)
  assert.match(call.result, /"status": "dispatched"/)
})

test("two delivery rows in a row are one wake turn; one after a reply is the next", () => {
  const turns = foldTurns([
    row(1, "user", "go"),
    stop(2, "Delegated."),
    batch(3),
    notice(4, "child-a"),
    stop(5, "First result."),
    notice(6, "child-b"),
    stop(7, "Second result."),
  ])
  assert.deepEqual(
    turns.map((turn) => [turn.wake ?? false, turn.delivered]),
    [
      [false, []],
      [true, ["child-a"]],
      [true, ["child-b"]],
    ],
  )
})

test("a wake turn the host has not answered yet is empty and not done", () => {
  const [, wake] = foldTurns([
    row(1, "user", "go"),
    stop(2, "Delegated."),
    batch(3),
    notice(4, "c"),
  ])
  assert.equal(wake.wake, true)
  assert.deepEqual(wake.parts, [])
  assert.equal(wake.done, false)
})

test("a row of any other role draws nothing and starts nothing", () => {
  const turns = foldTurns([row(1, "user", "go"), row(2, "session_meta", ""), stop(3, "Hi.")])
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].parts, [{ kind: "text", text: "Hi." }])
})

test("the goals a call asked for come from its arguments, or from its live label", () => {
  const [call] = foldTurns(parent)[0].parts[0].calls
  assert.deepEqual(goalsOf(call), [done[0].goal])
  assert.deepEqual(
    goalsOf({
      id: "x",
      name: "delegate_task",
      label: "1 tasks: Run the shell command `sleep 12 && ec...",
    }),
    ["Run the shell command `sleep 12 && ec"],
  )
  assert.deepEqual(
    goalsOf({ id: "x", name: "delegate_task", label: "2 tasks: first goal | second goal" }),
    ["first goal", "second goal"],
  )
  assert.deepEqual(goalsOf({ id: "x", name: "terminal" }), [], "another tool asked for nothing")
})

test("a card is its child's record, matched by goal, and says what that child is doing", () => {
  const [cards] = cardsOf(foldTurns(parent), done)
  assert.deepEqual(
    cards.map((card) => [card.goal, card.status, card.agent?.id]),
    [[done[0].goal, "done", CHILD]],
  )
  const [live] = cardsOf(
    foldTurns(parent),
    running.map((agent) => ({ ...agent, goal: done[0].goal })),
  )
  assert.equal(live[0].status, "running")
})

test("a call whose child has no record yet is starting, and a label's cut goal still finds it", () => {
  const turns = foldTurns([
    row(1, "user", "go"),
    row(2, "assistant", "", {
      finish_reason: "tool_calls",
      tool_calls: [
        {
          id: "c1",
          function: {
            name: "delegate_task",
            arguments: JSON.stringify({ tasks: [{ goal: "Do the thing" }] }),
          },
        },
      ],
    }),
  ])
  assert.equal(cardsOf(turns, [])[0][0].status, "starting")
  const live = [
    {
      id: "kid",
      goal: "Run the shell command `sleep 12 && echo hi`",
      status: "running",
      started_at: 1,
    },
  ]
  const cut = [
    {
      done: false,
      user: "go",
      delivered: [],
      parts: [
        {
          kind: "tools",
          calls: [
            {
              id: "c",
              name: "delegate_task",
              label: "1 tasks: Run the shell command `sleep 12 ...",
            },
          ],
        },
      ],
    },
  ]
  assert.equal(cardsOf(cut, live)[0][0].agent?.id, "kid")
})

test("two children with the same goal are matched in the order they started, each once", () => {
  const turns = foldTurns([
    row(1, "user", "go"),
    row(2, "assistant", "", {
      finish_reason: "tool_calls",
      tool_calls: [
        {
          id: "c1",
          function: {
            name: "delegate_task",
            arguments: JSON.stringify({ tasks: [{ goal: "same" }, { goal: "same" }] }),
          },
        },
      ],
    }),
  ])
  const agents = [
    { id: "late", goal: "same", status: "done", started_at: 20 },
    { id: "early", goal: "same", status: "running", started_at: 10 },
  ]
  assert.deepEqual(
    cardsOf(turns, agents)[0].map((card) => card.agent?.id),
    ["early", "late"],
  )
})
