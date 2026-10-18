import assert from "node:assert/strict"
import test from "node:test"

import { modelChanges, unknownLastTurn } from "../src/lib/model-changes.ts"

const sonnet = "anthropic/claude-sonnet-4.5"
const gpt = "openai/gpt-5"
const gemini = "google/gemini-2.5-pro"

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

test("the newest turn takes its pick where the host hasn't named its own call", () => {
  const thread = [...turn(1, 100), ...turn(2, 200, gpt)]
  const dividers = modelChanges(thread, [change(100, sonnet)])
  assert.deepEqual([...dividers], [["u2", gpt]])
})

test("so a switch shows from the moment its turn starts, not when the turn ends", () => {
  const thread = [
    ...turn(1, 100),
    message("u2", "user", 200),
    message("a2", "assistant", 201, { model: gpt, status: "streaming" }),
  ]
  assert.deepEqual([...modelChanges(thread, [change(100, sonnet)])], [["u2", gpt]])
})

test("a turn still being written keeps its pick even with a newer turn below it", () => {
  // The queued case in ADR 0010: the turn that started while an older one streamed ends, so `end` is
  // finite and only `running` can carry the pick — the host hasn't named that turn's call yet.
  const thread = [
    ...turn(1, 100),
    message("u2", "user", 200),
    message("a2", "assistant", 201, { model: gpt, status: "streaming" }),
    ...turn(3, 300, gpt),
  ]
  assert.deepEqual([...modelChanges(thread, [change(100, sonnet)])], [["u2", gpt]])
})

test("the host's own row for the newest turn replaces its pick", () => {
  // The turn asked for one model and the host ran a third: its row inside the turn is the word on what
  // happened, so the divider names that, not the pick. (Rows only exist where the model differs from
  // the last one, as the plugin's hook writes them — never two in a row for the same model.)
  const thread = [...turn(1, 100), ...turn(2, 200, gpt)]
  const dividers = modelChanges(thread, [change(100, sonnet), change(250, gemini)])
  assert.deepEqual([...dividers], [["u2", gemini]])
})

test("a turn with a newer one below it keeps the model the host carried into it", () => {
  const thread = [...turn(1, 100), ...turn(2, 200, gpt), ...turn(3, 300)]
  const dividers = modelChanges(thread, [change(100, sonnet)])
  assert.deepEqual([...dividers], [])
})

test("the record is asked for only where nothing names the turn above the next one", () => {
  // Nothing at all names it: a read of the host's record could, so the next turn asks for it.
  assert.equal(unknownLastTurn([...turn(1, 100)], []), true)
  // The host has named it.
  assert.equal(unknownLastTurn([...turn(1, 100)], [change(100, sonnet)]), false)
  // This device sent the turn with a pick of its own.
  assert.equal(unknownLastTurn([...turn(1, 100, sonnet)], []), false)
  assert.equal(unknownLastTurn([], []), false)
})
