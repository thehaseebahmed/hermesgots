import assert from "node:assert/strict"
import test from "node:test"

import { mainTail, orderTail } from "../src/lib/main-tail.ts"

const thread = (id, createdAt, extra = {}) => ({
  chat: {
    id,
    profileId: "bot-1",
    title: `Thread ${id}`,
    hermesSessionId: `gots-${id}`,
    createdAt,
    updatedAt: createdAt,
    changedAt: 0,
    ...extra,
  },
  replies: 0,
  state: "idle",
})

const move = (id, at, extra = {}) => ({
  id,
  text: `text of ${id}`,
  threadId: "t-older",
  at,
  undone: false,
  undoable: false,
  ...extra,
})

const compaction = (at) => ({ at, tokens: 1000, window: 8000 })

const drawn = (tail) =>
  tail.map(
    (item) =>
      `${item.kind}:${
        item.kind === "card" ? item.thread.chat.id : item.kind === "move" ? item.move.id : item.at
      }@${item.at}`,
  )

test("a move older than every card leads the tail, so no card outranks it", () => {
  const tail = mainTail({
    cards: [thread("t-litellm", 40), thread("t-clef", 30)],
    moves: [move("m-gots", 10)],
  })
  assert.deepEqual(drawn(tail), ["move:m-gots@10", "card:t-clef@30", "card:t-litellm@40"])
})

test("a move made after a card follows it", () => {
  const tail = mainTail({
    cards: [thread("t-old", 10), thread("t-new", 30)],
    moves: [move("m20", 20)],
  })
  assert.deepEqual(drawn(tail), ["card:t-old@10", "move:m20@20", "card:t-new@30"])
})

test("a Main's tail is its cards and its moves, in their own time", () => {
  const tail = mainTail({
    cards: [thread("t10", 10), thread("t40", 40)],
    moves: [move("m30", 30)],
  })
  assert.deepEqual(drawn(tail), ["card:t10@10", "move:m30@30", "card:t40@40"])
})

test("a compaction draws no divider at the foot of the flow", () => {
  // `mainTail` has no compaction to hand in: a divider stands between two messages, so one made after
  // everything written has nothing to stand between until the next message arrives (compactions.ts).
  const tail = mainTail({ cards: [thread("t10", 10)] })
  assert.deepEqual(drawn(tail), ["card:t10@10"])
})

test("two items at one moment keep a total order by id, not by kind", () => {
  const tail = mainTail({ cards: [thread("t20", 20)], moves: [move("m20", 20)] })
  assert.deepEqual(drawn(tail), ["move:m20@20", "card:t20@20"])
})

test("nothing trailing, or nothing handed in at all, draws nothing", () => {
  assert.deepEqual(mainTail({}), [])
  assert.deepEqual(mainTail({ cards: [], moves: [] }), [])
  assert.deepEqual(mainTail({ moves: [move("m10", 10)] }).length, 1)
})

test("what stands above one message is one timeline too, by the same order", () => {
  // The same three producers, anchored instead of trailing: a flow hands their bucket to this, so a
  // card begun after a move can never be drawn above it (ADR 0097).
  const above = orderTail([
    { kind: "card", at: 40, thread: thread("t40", 40) },
    { kind: "move", at: 10, move: move("m10", 10) },
    { kind: "compaction", at: 20, compaction: compaction(20) },
  ])
  assert.deepEqual(drawn(above), ["move:m10@10", "compaction:20@20", "card:t40@40"])
  assert.deepEqual(orderTail([]), [])
})
