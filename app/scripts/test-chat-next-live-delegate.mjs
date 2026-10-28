/**
 * A delegation as the real Hermes 0.22.5 recorded it (`fixtures/live.*`: the run's event stream, the
 * finished transcript and the plugin's agent list for one session): the parent's reply writes a
 * sentence and calls `delegate_task` in one assistant row, the call returns "dispatched" at once, the
 * parent says "Delegated.", and the child's finish arrives as two delivery rows before the wake turn.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { cardsOf } from "../src/chat-next/agents.ts"
import { foldTurns } from "../src/chat-next/fold.ts"
import { recorded } from "./chat-next-fixtures.ts"

const rows = recorded("live.transcript.json").data
const agents = recorded("live.agents.json").agents
const turns = foldTurns(rows)

const shape = (turn) =>
  turn.parts.map((part) =>
    part.kind === "text" ? "text" : `tools:${part.calls.map((call) => call.name).join()}`,
  )

test("the real transcript is two turns: the request, then a wake turn that answers none", () => {
  assert.equal(turns.length, 2)
  assert.equal(turns[0].wake, undefined)
  assert.equal(turns[1].wake, true)
  assert.match(turns[1].user, /^$/)
  assert.deepEqual(turns[1].delivered, [agents[0].id])
  assert.ok(turns.every((turn) => turn.done))
})

test("the sentence the agent wrote before delegating comes before the call, then Delegated.", () => {
  assert.deepEqual(shape(turns[0]), ["text", "tools:delegate_task", "text"])
  assert.match(turns[0].parts[0].text, /spin up a subagent/)
  assert.equal(turns[0].parts[2].text.trim(), "Delegated.")
})

test("the wake turn is the agent's reply to the child's result and shows no delivery text", () => {
  assert.deepEqual(shape(turns[1]), ["text"])
  assert.match(turns[1].parts[0].text, /live-check/)
  assert.ok(!JSON.stringify(turns).includes("ASYNC DELEGATION"))
})

test("the call becomes a done card carrying the real child's id and goal", () => {
  const cards = cardsOf(turns, agents)
  assert.deepEqual(
    cards.map((list) => list.map((card) => card.status)),
    [["done"], []],
  )
  assert.equal(cards[0][0].agent.id, agents[0].id)
  assert.match(cards[0][0].goal, /sleep 10 && echo live-check/)
})
