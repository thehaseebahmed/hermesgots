import assert from "node:assert/strict"
import test from "node:test"

import { openerWords, threadCards } from "../src/lib/thread-cards.ts"

const message = (id, createdAt, extra = {}) => ({
  id,
  conversationId: "main-bot-1",
  role: "user",
  content: id,
  status: "done",
  createdAt,
  ...extra,
})

const chat = (id, createdAt, extra = {}) => ({
  id,
  profileId: "bot-1",
  title: `Thread ${id}`,
  hermesSessionId: `gots-${id}`,
  createdAt,
  updatedAt: createdAt,
  changedAt: 0,
  ...extra,
})

const thread = (id, createdAt, extra = {}) => ({
  chat: chat(id, createdAt),
  replies: 0,
  state: "idle",
  ...extra,
})

const main = (createdAt) =>
  thread("main-bot-1", createdAt, { chat: chat("main-bot-1", createdAt, { main: true }) })

const above = (cards, id) => (cards.before.get(id) ?? []).map((one) => one.chat.id)
const trailing = (cards) => cards.trailing.map((one) => one.chat.id)

test("a thread's card sits above the first message written after it started", () => {
  const messages = [message("m10", 10), message("m20", 20), message("m30", 30)]
  const cards = threadCards(messages, [thread("t15", 15)])
  assert.deepEqual(above(cards, "m20"), ["t15"])
  assert.deepEqual(above(cards, "m10"), [])
  assert.deepEqual(trailing(cards), [])
})

test("a thread begun days ago sits between Main's older messages", () => {
  const day = 86_400_000
  const messages = [message("d1", day), message("d3", 3 * day), message("d9", 9 * day)]
  const cards = threadCards(messages, [
    thread("started-d2", 2 * day),
    thread("started-d5", 5 * day),
  ])
  assert.deepEqual(above(cards, "d3"), ["started-d2"])
  assert.deepEqual(above(cards, "d9"), ["started-d5"])
})

test("a thread begun before everything Main shows leads the flow", () => {
  const cards = threadCards([message("m10", 10)], [thread("t5", 5)])
  assert.deepEqual(above(cards, "m10"), ["t5"])
})

test("a thread begun after everything Main shows is drawn at the end", () => {
  const cards = threadCards([message("m10", 10)], [thread("t20", 20)])
  assert.deepEqual(trailing(cards), ["t20"])
  assert.deepEqual(above(cards, "m10"), [])
})

test("Main is never a card among its own messages", () => {
  const cards = threadCards([message("m10", 10), message("m20", 20)], [main(1), thread("t15", 15)])
  assert.deepEqual(above(cards, "m20"), ["t15"])
  assert.deepEqual(trailing(cards), [])
})

test("a later message or reply does not move its card", () => {
  const messages = [message("m10", 10), message("m30", 30)]
  const started = thread("t20", 20)
  const before = threadCards(messages, [started])
  const replied = {
    ...started,
    replies: 4,
    last: "Something the bot said",
    state: "waiting",
    reason: { kind: "question", count: 1 },
  }
  replied.chat = { ...started.chat, updatedAt: 99, title: "Renamed" }
  const after = threadCards(messages, [replied])
  assert.deepEqual(above(after, "m30"), ["t20"])
  assert.deepEqual(above(before, "m30"), above(after, "m30"))
  assert.deepEqual(trailing(after), trailing(before))
})

test("two threads begun at the same moment keep a total order, by id", () => {
  const cards = threadCards(
    [message("m10", 10), message("m30", 30)],
    [thread("t20-b", 20), thread("t20-a", 20)],
  )
  assert.deepEqual(above(cards, "m30"), ["t20-a", "t20-b"])
})

test("a thread begun at a message's own time sits below it, as a marker does", () => {
  const cards = threadCards([message("m10", 10), message("m20", 20)], [thread("t20", 20)])
  assert.deepEqual(above(cards, "m10"), [])
  assert.deepEqual(trailing(cards), ["t20"])
})

test("no threads, or none yet read, draws nothing", () => {
  const messages = [message("m10", 10)]
  for (const threads of [undefined, []]) {
    const cards = threadCards(messages, threads)
    assert.equal(cards.before.size, 0)
    assert.deepEqual(trailing(cards), [])
  }
})

test("a card's bubble says the move that opened its thread before anything else", () => {
  const opened = thread("t30", 30, { opener: "What the user typed in it" })
  assert.equal(openerWords(opened, { text: "What triage moved in" }), "What triage moved in")
})

test("a card stands at its opener's own time, not the record's", () => {
  const baz = thread("t20", 20, { chat: chat("t20", 20, { opener: "typed at nine", openerAt: 9 }) })
  const cards = threadCards([message("m10", 10), message("m12", 12), message("m30", 30)], [baz])
  assert.deepEqual(above(cards, "m10"), ["t20"], "the card stands by the message the reader sent")
  assert.deepEqual(above(cards, "m30"), [])
})

test("a card's bubble says the first message the user sent, and nothing without one", () => {
  assert.equal(
    openerWords(thread("t30", 30, { opener: "What the user typed in it" })),
    "What the user typed in it",
  )
  // A thread this device holds no message of draws no bubble: its name is the card's line, and the
  // name never stands in for a message nobody here has.
  assert.equal(openerWords(thread("t30", 30)), undefined)
})
