/**
 * Compaction while subagents run, as Hermes 0.22.5 writes it (`fixtures/delegate-compaction.*`,
 * recorded from a real host with `compression.threshold` lowered): a turn sets four children to
 * work, a second turn pulls large outputs while they run, and the host compacts in the middle of it.
 * The children keep running. The host archives the `delegate_task` call, restates the first request
 * as a user row, and writes the work it carried forward again under the same call ids. Only the
 * random output is replaced; the structure is the host's own.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { cardsOf } from "../src/chat-next/agents.ts"
import { foldTurns, withArchive } from "../src/chat-next/fold.ts"

const recorded = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../src/chat-next/fixtures/delegate-compaction.${name}`, import.meta.url),
      "utf8",
    ),
  )

const live = recorded("live.json").data
const archive = recorded("archive.json").data
const running = recorded("agents.running.json").agents
const done = recorded("agents.done.json").agents

const kinds = (turn) => turn.parts.map((part) => part.kind)
const statuses = (cards) => cards.map((card) => card.status)
const FIRST = /^Use the delegate_task tool/
const SECOND = /^While they run/

test("the recording caught the children running when the host compacted, and archived their call", () => {
  assert.equal(running.length, 4)
  assert.ok(running.every((agent) => agent.status === "running"))
  assert.ok(done.every((agent) => agent.status === "done"))
  assert.equal(recorded("runs-live.json").subagents["memento-fixture-delegate-compaction"], 4)
  assert.equal(live[0].display_kind, "hidden", "the live read opens on the compaction")
  const liveCalls = live.flatMap((row) => (row.tool_calls ?? []).map((call) => call.function.name))
  assert.ok(!liveCalls.includes("delegate_task"), "the call is only in the archive")
  const archived = archive.flatMap((row) =>
    (row.tool_calls ?? []).map((call) => call.function.name),
  )
  assert.ok(archived.includes("delegate_task"))
})

test("the host's read: the first request is gone, so its reply is a carried turn with no bubble", () => {
  const [first, second] = foldTurns(live)
  assert.equal(first.carried, true)
  assert.equal(first.user, "")
  assert.deepEqual(kinds(first), ["compaction", "text"])
  assert.match(first.parts[1].text, /^I delegated four subagents/)
  assert.match(second.user, SECOND)
  assert.equal(second.carried, undefined)
})

test("the children still draw as cards on the carried turn, since the call that named them is archived", () => {
  const cards = cardsOf(foldTurns(live), running)
  assert.deepEqual(statuses(cards[0]), ["running", "running", "running", "running"])
  assert.deepEqual(cards.slice(1).flat(), [])
  assert.ok(cards[0].every((card) => card.agent))
})

test("the cards turn done with the children, in place", () => {
  assert.deepEqual(statuses(cardsOf(foldTurns(live), done)[0]), ["done", "done", "done", "done"])
})

test("the restatement is the request carried, never a message of the user's", () => {
  const restated = archive.find((row) => row.content?.startsWith("[STILL IN PROGRESS"))
  assert.ok(restated, "the archive holds the restatement as a plain user row")
  assert.equal(restated.display_kind, undefined)
  const turns = foldTurns(withArchive(live, archive))
  assert.ok(turns.every((turn) => !turn.user.startsWith("[STILL IN PROGRESS")))
})

test("the work archived under the second request follows it, not the turn above", () => {
  const ids = withArchive(live, archive).map((row) => row.id)
  assert.equal(ids.length, archive.length, "every row once")
  assert.ok(ids.indexOf(76763) < ids.indexOf(76737), "the request comes before its first call")
  assert.ok(ids.indexOf(76732) < ids.indexOf(76763))
})

test("with the archive, the first turn is whole again, its compaction after it, and the carried copy adds nothing", () => {
  const [first, second, ...rest] = foldTurns(withArchive(live, archive))
  assert.match(first.user, FIRST)
  assert.deepEqual(kinds(first), ["tools", "text", "compaction"])
  assert.equal(first.parts[0].calls[0].name, "delegate_task")
  assert.match(
    first.parts[0].calls[0].result,
    /"status": "dispatched"/,
    "its own result, not the cleared notice",
  )
  assert.equal(first.done, true)
  assert.equal(foldTurns(withArchive(live, archive)).filter((turn) => turn.carried).length, 0)
  // The reply Hermes wrote again after the seam is the one already drawn.
  const replies = [first, second, ...rest].flatMap((turn) =>
    turn.parts.filter((part) => part.kind === "text" && /^I delegated four/.test(part.text)),
  )
  assert.equal(replies.length, 1)
})

test("with the archive, the second turn draws every call once, its carried copies dropped", () => {
  const second = foldTurns(withArchive(live, archive))[1]
  assert.match(second.user, SECOND)
  assert.deepEqual(kinds(second), ["tools", "text"])
  assert.equal(second.parts[0].calls.length, 3, "the terminal calls, not their carried copies")
  assert.deepEqual(
    second.parts[0].calls.map((call) => call.id),
    ["call_29232a12b4d0", "call_292089fc6e40", "chatcmpl-tool-84ddbe8442351f6b"],
  )
  assert.equal(second.done, true)
})

test("a call keeps its output when the carried copy of it was cleared", () => {
  const [call] = foldTurns(withArchive(live, archive))[1].parts[0].calls
  assert.doesNotMatch(call.result, /^\[Old tool output cleared/)
  // Without the archive only the cleared copy exists, and that is what the host holds.
  const alone = foldTurns(live)[1].parts[0].calls[0]
  assert.match(alone.result, /^\[Old tool output cleared/)
})

test("with the archive, the cards stay on the call that named the children", () => {
  const turns = foldTurns(withArchive(live, archive))
  const cards = cardsOf(turns, running)
  assert.deepEqual(statuses(cards[0]), ["running", "running", "running", "running"])
  assert.deepEqual(cards.slice(1).flat(), [])
})

test("the wake turns that follow report the children, one batch to a turn", () => {
  for (const rows of [live, withArchive(live, archive)]) {
    const wakes = foldTurns(rows).filter((turn) => turn.wake)
    assert.equal(wakes.length, 2)
    assert.equal(wakes[0].delivered.length, 1, "the first child to finish")
    assert.equal(wakes[1].delivered.length, 0, "the batch and its process notice are one wake turn")
    assert.ok(wakes.every((turn) => turn.done))
  }
  assert.ok(
    foldTurns(live).every((turn) => !/^\[IMPORTANT/.test(turn.user)),
    "the host's process notice is not the user's",
  )
})

test("a carried turn claims only the children no call did", () => {
  const turns = [
    { user: "", carried: true, parts: [], done: true, delivered: [] },
    {
      user: "go",
      parts: [
        {
          kind: "tools",
          calls: [
            {
              id: "c",
              name: "delegate_task",
              arguments: JSON.stringify({ goal: running[0].goal }),
            },
          ],
        },
      ],
      done: true,
      delivered: [],
    },
  ]
  const cards = cardsOf(turns, running)
  assert.equal(cards[1].length, 1)
  assert.equal(cards[1][0].agent.id, running[0].id)
  assert.equal(cards[0].length, 3)
})

test("a long goal finds its child though the host lists it on one line and cut short", () => {
  const goal = `${"Run the command and report it.\n\n".repeat(12)}Then stop.`
  const agent = { ...running[0], goal: goal.replace(/\s+/g, " ").slice(0, 280) }
  const turns = [
    {
      user: "go",
      parts: [
        {
          kind: "tools",
          calls: [{ id: "c", name: "delegate_task", arguments: JSON.stringify({ goal }) }],
        },
      ],
      done: true,
      delivered: [],
    },
  ]
  assert.equal(cardsOf(turns, [agent])[0][0].agent?.id, agent.id)
})
