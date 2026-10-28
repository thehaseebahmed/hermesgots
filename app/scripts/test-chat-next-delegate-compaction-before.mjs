/**
 * Compaction after the children finished, as Hermes 0.22.5 writes it
 * (`fixtures/delegate-compaction-before.*`, recorded from a real host with `compression.threshold`
 * lowered). A turn set four children to work; the first two tries at the call were refused (the
 * model's `output_schema` was invalid) and the third was dispatched. The children finished and the
 * host started the wake turns they owe; the last was still being written when the user sent the
 * next message, and the host compacted before running it.
 *
 * This compaction leaves no `hidden` row. The live read opens on the first request written again
 * under a new id, with the first refused call carried and its output pruned to a one-line summary
 * (`[delegate_task] ... FAILED`); the dispatched call and the first child's delivery are archived,
 * and the carried wake reply lost the reason it stopped.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { cardsOf, goalsOf } from "../src/chat-next/agents.ts"
import { foldTurns, withArchive } from "../src/chat-next/fold.ts"

const recorded = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../src/chat-next/fixtures/delegate-compaction-before.${name}`, import.meta.url),
      "utf8",
    ),
  )

const pre = recorded("pre.json").data
const live = recorded("live.json").data
const archive = recorded("archive.json").data
const running = recorded("agents.running.json").agents
const done = recorded("agents.done.json").agents

const kinds = (turn) => turn.parts.map((part) => part.kind)
const statuses = (cards) => cards.map((card) => card.status)
const callsOf = (turn) => turn.parts.flatMap((part) => part.calls ?? [])
const FIRST = /^Use the delegate_task tool/
const NEXT = /^Now call the terminal/

test("the recording: four children finished, the host's compaction left no hidden row", () => {
  assert.ok(
    running.every((agent) => agent.status === "running"),
    "caught at work after the first turn",
  )
  assert.equal(done.length, 4)
  assert.ok(done.every((agent) => agent.status === "done"))
  for (const rows of [pre, live, archive])
    assert.ok(rows.every((row) => row.display_kind !== "hidden"))
  const liveCalls = live.flatMap((row) => (row.tool_calls ?? []).map((call) => call.id))
  assert.ok(
    !liveCalls.includes("call-62b45511-7343-4786-9cae-f0be99ee9a99"),
    "the dispatched call is archived",
  )
  assert.ok(
    liveCalls.includes("call-20e2be95-688f-46b3-badb-fe815ce25dca"),
    "a refused one is carried",
  )
})

test("before the compaction: two refused tries and one dispatched, and only the dispatched draws cards", () => {
  const [first] = foldTurns(pre)
  assert.deepEqual(
    callsOf(first).map((call) => (/^\{"error"/.test(call.result) ? "refused" : "dispatched")),
    ["refused", "refused", "dispatched"],
  )
  assert.deepEqual(
    callsOf(first).map((call) => goalsOf(call).length),
    [0, 0, 4],
  )
  assert.deepEqual(statuses(cardsOf(foldTurns(pre), running)[0]), [
    "running",
    "running",
    "running",
    "running",
  ])
  assert.deepEqual(statuses(cardsOf(foldTurns(pre), done)[0]), ["done", "done", "done", "done"])
})

test("before the compaction: the first child's wake turn is whole, the batch's is still owed", () => {
  const [, first, owed] = foldTurns(pre)
  assert.equal(first.wake, true)
  assert.equal(first.delivered.length, 1)
  assert.equal(first.done, true)
  assert.equal(owed.wake, true)
  assert.equal(owed.done, false, "the host has not written its reply")
  assert.equal(
    recorded("runs-live.json").sessions["memento-fixture-delegate-compaction-before"],
    "running",
  )
})

test("the host's read opens on the request again, with a refused call carried and no divider", () => {
  const turns = foldTurns(live)
  assert.match(turns[0].user, FIRST)
  assert.equal(
    turns.some((turn) => turn.carried),
    false,
  )
  assert.ok(turns.every((turn) => !kinds(turn).includes("compaction")))
  const [call] = callsOf(turns[0])
  assert.match(call.result, /^\[delegate_task\] .*chars result\) FAILED/, "the pruned summary")
  assert.deepEqual(goalsOf(call), [], "a refused call set nobody to work")
})

test("the children finished before the compaction still draw as done cards, though their call is archived", () => {
  const cards = cardsOf(foldTurns(live), done)
  assert.deepEqual(statuses(cards[0]), ["done", "done", "done", "done"])
  assert.deepEqual(cards.slice(1).flat(), [])
})

test("a turn is finished by what follows it, though the carried reply lost why it stopped", () => {
  const carriedReply = live.find(
    (row) => row.role === "assistant" && !row.tool_calls?.length && !row.finish_reason,
  )
  assert.ok(carriedReply, "the recording holds a reply with no finish reason")
  const turns = foldTurns(live)
  assert.ok(turns.slice(0, -1).every((turn) => turn.done))
  assert.equal(turns.at(-1).done, true)
})

test("the live read's turns: the request, the batch's wake turn, then the next message", () => {
  const turns = foldTurns(live)
  assert.equal(turns.length, 3)
  assert.equal(turns[1].wake, true)
  assert.match(turns[2].user, NEXT)
  assert.equal(callsOf(turns[2]).length, 3)
  assert.ok(
    turns.every((turn) => !turn.user.startsWith("[")),
    "no host row drawn as a message",
  )
})

test("with the archive, the dispatched call and the first child's delivery are back", () => {
  const turns = foldTurns(withArchive(live, archive))
  assert.match(turns[0].user, FIRST)
  assert.deepEqual(
    callsOf(turns[0]).map((call) => goalsOf(call).length),
    [0, 0, 4],
  )
  assert.deepEqual(
    turns.filter((turn) => turn.wake).map((turn) => turn.delivered.length),
    [1, 0],
  )
  assert.match(turns.at(-1).user, NEXT)
  assert.ok(turns.every((turn) => turn.done))
})

test("with the archive, each call is drawn once and the cards are the dispatched call's", () => {
  const turns = foldTurns(withArchive(live, archive))
  const ids = turns.flatMap(callsOf).map((call) => call.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(statuses(cardsOf(turns, done)[0]), ["done", "done", "done", "done"])
  assert.deepEqual(cardsOf(turns, done).slice(1).flat(), [])
  // The refused tries' results keep their own error, not the pruned summary.
  assert.match(callsOf(turns[0])[0].result, /^\{"error"/)
})

test("a refused delegate call draws no cards, whether its result is whole, cut short or pruned", () => {
  const call = (result) => ({
    id: "c",
    name: "delegate_task",
    arguments: JSON.stringify({ tasks: [{ goal: "one" }, { goal: "two" }] }),
    result,
  })
  assert.deepEqual(goalsOf(call('{"error": "Task 0 invalid')), [])
  assert.deepEqual(
    goalsOf(call("[delegate_task] '' (363 chars result) FAILED: Task 0 invalid")),
    [],
  )
  assert.deepEqual(goalsOf(call('{"status": "dispatched", "count": 2}')), ["one", "two"])
  assert.deepEqual(goalsOf(call(undefined)), ["one", "two"], "a call still running")
})

test("children no call names go to the turn whose attempts were refused, never to a turn that has none", () => {
  const refused = {
    user: "go",
    parts: [
      {
        kind: "tools",
        calls: [{ id: "c", name: "delegate_task", arguments: "{}", result: '{"error": "x"}' }],
      },
    ],
    done: true,
    delivered: [],
  }
  const plain = { user: "next", parts: [], done: true, delivered: [] }
  assert.equal(cardsOf([plain, plain], done).flat().length, 0)
  assert.equal(cardsOf([refused, plain], done)[0].length, 4)
})
