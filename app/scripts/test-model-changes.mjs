import assert from "node:assert/strict"
import test from "node:test"

import { modelChanges } from "../src/lib/model-changes.ts"

const sonnet = "anthropic/claude-sonnet-4.5"
const gpt = "openai/gpt-5"

const message = (id, role, createdAt, extra = {}) => ({
  id,
  conversationId: "c1",
  role,
  content: "",
  status: "done",
  createdAt,
  ...extra,
})

/** One turn: the user's message, then the reply that answers it. */
const turn = (n, at, sent) => [
  message(`u${n}`, "user", at),
  message(`a${n}`, "assistant", at + 1, sent ? { model: sent } : {}),
]

const change = (at, model) => ({ at, model })

test("a switch between turns draws one divider, above the turn it answered", () => {
  const thread = [...turn(1, 100), ...turn(2, 200)]
  const dividers = modelChanges(thread, [change(100, sonnet), change(200, gpt)])
  assert.deepEqual([...dividers], [["u2", gpt]])
})

test("a switch picked on this device shows even when the host recorded nothing", () => {
  const thread = [...turn(1, 100, sonnet), ...turn(2, 200, gpt)]
  assert.deepEqual([...modelChanges(thread, [])], [["u2", gpt]])
})

test("a host-side switch shows, and stays until the model changes again", () => {
  const thread = [...turn(1, 100), ...turn(2, 200), ...turn(3, 300)]
  const dividers = modelChanges(thread, [change(100, sonnet), change(250, gpt)])
  assert.deepEqual([...dividers], [["u2", gpt]])
})

test("a switch inside one turn lands on the next turn, not inside the one it fell in", () => {
  const thread = [...turn(1, 100), ...turn(2, 200), ...turn(3, 300)]
  const dividers = modelChanges(thread, [
    change(100, sonnet),
    change(200, sonnet),
    change(250, gpt),
  ])
  assert.deepEqual([...dividers], [["u3", gpt]])
})

test("re-picking the same model adds nothing", () => {
  const thread = [...turn(1, 100), ...turn(2, 200), ...turn(3, 300, gpt)]
  const dividers = modelChanges(thread, [change(100, sonnet), change(200, gpt)])
  assert.deepEqual([...dividers], [["u2", gpt]])
})

test("a vendor prefix doesn't make a new model", () => {
  const thread = [...turn(1, 100), ...turn(2, 200, sonnet)]
  const dividers = modelChanges(thread, [change(100, "claude-sonnet-4-5")])
  assert.deepEqual([...dividers], [])
})

test("an unknown first turn draws nothing: the app can't tell a switch from a start", () => {
  const thread = [...turn(1, 100), ...turn(2, 200)]
  assert.deepEqual([...modelChanges(thread, [change(200, gpt)])], [])
})

test("alternating models draw a divider each time", () => {
  const thread = [...turn(1, 100), ...turn(2, 200), ...turn(3, 300)]
  const dividers = modelChanges(thread, [
    change(100, sonnet),
    change(200, gpt),
    change(300, sonnet),
  ])
  assert.deepEqual(
    [...dividers],
    [
      ["u2", gpt],
      ["u3", sonnet],
    ],
  )
})

test("a turn whose user row isn't loaded still counts its reply's model", () => {
  const thread = [message("a1", "assistant", 100, { model: sonnet }), ...turn(2, 200, gpt)]
  assert.deepEqual([...modelChanges(thread, [])], [["u2", gpt]])
})

test("an empty thread has nothing to draw", () => {
  assert.deepEqual([...modelChanges([], [change(100, sonnet)])], [])
})
