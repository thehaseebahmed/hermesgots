/**
 * A bot's chat list as a rule: what one row says, the order the rows are drawn in, and what a search
 * keeps. The screen draws exactly this (`routes/bot-chats.tsx`), so an ordering, a line or a search
 * that went wrong is read here, with a seeded row and no DOM (AGENTS.md's unit tier).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { chatAge, chatList, chatRowOf, orderChatRows } from "../src/lib/chat-list.ts"

const HOUR = 3_600_000
const DAY = 86_400_000

/** A chat's record, as the list reads it: the fields it draws a row from. */
const chat = (id, at, patch = {}) => ({
  id,
  title: `Chat ${id}`,
  updatedAt: at,
  ...patch,
})

/** The newest message this device holds for a chat. */
const said = (text, at, patch = {}) => ({ content: text, createdAt: at, ...patch })

test("a row's line is the bot's last word, and its time the chat's newest message", () => {
  const row = chatRowOf(chat("a", 100), said("the last thing said", 240))
  assert.equal(row.line, "the last thing said", "the line is the newest words")
  assert.equal(row.at, 240, "and its time is that message's, not the record's")
  assert.equal(row.title, "Chat a")
  assert.equal(row.id, "a")
})

test("a row says what the reader was told, not what they typed under it", () => {
  // The reader spoke last: the row's place is when the chat moved, its words are the bot's.
  const mine = said("now do the next thing please", 300, { role: "user" })
  const told = said("The build is green.", 240)
  const row = chatRowOf(chat("a", 100), mine, told)
  assert.equal(row.line, "The build is green.", "the line is the last thing received")
  assert.equal(row.at, 300, "and the row is ordered by the newest message of any role")
})

test("a chat the bot has not answered yet says the reader's own words", () => {
  // Nothing has come back, so the reader's message is all this chat has said.
  const mine = said("are you there?", 300, { role: "user" })
  assert.equal(chatRowOf(chat("a", 100), mine, undefined).line, "are you there?")
  assert.equal(
    chatRowOf(chat("a", 100), mine).line,
    "are you there?",
    "a row read in one go is the same",
  )
})

test("a row names the session its chat answers at, and whether a reply is still arriving", () => {
  // The list asks the host about this session, since a run started elsewhere shows in no message here.
  const row = chatRowOf(chat("a", 100, { hermesSessionId: "sess-1" }), said("Writing…", 240))
  assert.equal(row.session, "sess-1")
  assert.equal(row.streaming, undefined, "a finished reply is not a run in flight")
  assert.equal(
    chatRowOf(chat("a", 100, { hermesSessionId: "sess-1" }), said("Writ", 240, { status: "streaming" }))
      .streaming,
    true,
    "a reply still streaming is",
  )
  const routine = chatRowOf(chat("r", 100, { routine: true, line: "A delivery" }))
  assert.equal(routine.session, undefined, "a routine's row asks the host nothing about a chat")
  assert.equal(routine.streaming, undefined)
})

test("a chat nothing has been said in keeps its own clock and draws no line", () => {
  const row = chatRowOf(chat("a", 100))
  assert.equal(row.line, undefined, "nothing said, nothing to preview")
  assert.equal(row.at, 100, "so the row is placed by when the chat was made")
})

test("a reply that waits on the reader says why, in Code's words", () => {
  const asking = said("Shall I?", 240, {
    clarify: { runId: "r", clarifyId: "c", questions: [{ id: "q", question: "Shall I?" }] },
  })
  assert.equal(chatRowOf(chat("a", 100), asking).needs, "Awaiting your answer", "a question waits")
  const answered = {
    ...asking,
    clarify: { ...asking.clarify, resolved: { answers: { q: "Yes" }, outcome: "submitted" } },
  }
  assert.equal(chatRowOf(chat("a", 100), answered).needs, undefined, "an answered one does not")
  const approved = said("Run it?", 240, {
    approval: {
      runId: "r",
      command: "rm -rf build",
      choices: [{ id: "once", label: "Allow once" }],
    },
  })
  assert.equal(
    chatRowOf(chat("a", 100), approved).needs,
    "Approve rm -rf build",
    "so does an approval",
  )
  assert.equal(
    chatRowOf(chat("a", 100)).needs,
    undefined,
    "a chat with nothing said is not waiting",
  )
})

test("two of the reader's questions are counted, not named", () => {
  const asking = said("Two things:", 240, {
    clarify: {
      runId: "r",
      clarifyId: "c",
      questions: [
        { id: "a", question: "Now?" },
        { id: "b", question: "Or later?" },
      ],
    },
  })
  assert.equal(chatRowOf(chat("a", 100), asking).needs, "2 questions to answer")
})

test("a chat whose newest row is the reader's own still waits on the reply above it", () => {
  const asking = said("Shall I?", 240, {
    clarify: { runId: "r", clarifyId: "c", questions: [{ id: "q", question: "Shall I?" }] },
  })
  const mine = said("yes, go on", 300, { role: "user" })
  assert.equal(
    chatRowOf(chat("a", 100), mine, asking).needs,
    "Awaiting your answer",
    "typing does not answer the reply that asked",
  )
  assert.equal(
    chatRowOf(chat("a", 100), mine).needs,
    undefined,
    "a row with no reply named asks its newest one",
  )
  assert.equal(
    chatRowOf(chat("a", 100), mine, asking).line,
    "Shall I?",
    "and the line is the reply that asked, not the reader's answer to it",
  )
})

test("pinned rows come first, and the rest by their last message", () => {
  const rows = [
    chatRowOf(chat("older", 100)),
    chatRowOf(chat("newest", 300)),
    chatRowOf(chat("pinned", 50, { pinned: true })),
    chatRowOf(chat("middle", 200)),
  ]
  assert.deepEqual(
    orderChatRows(rows).map((row) => row.id),
    ["pinned", "newest", "middle", "older"],
    "a pin lifts a quiet chat over a busy one, and the band under it reads newest first",
  )
})

test("two chats last spoken in at one moment keep one order, whatever the reader's device", () => {
  const rows = [chatRowOf(chat("b", 200)), chatRowOf(chat("a", 200))]
  assert.deepEqual(
    orderChatRows(rows).map((row) => row.id),
    ["a", "b"],
  )
})

test("a routine's row reads its line and its time from its record, not from a message", () => {
  // A delivery's words are in the run's own session, so this device holds no message for the row at
  // all: the plugin writes the first line onto the record, and the row draws that (G4).
  const row = chatRowOf(
    chat("routine-job-1-cron_1", 400, { routine: true, line: "The tide turns at 06:40" }),
  )
  assert.equal(row.line, "The tide turns at 06:40", "the record's line is the row's")
  assert.equal(row.at, 400, "and the record's clock places and ages it")
  assert.equal(row.routine, true, "the row says it is a run, so the list can wear its own icon")
  // A message on the row would be a second telling of it, and the record is the one the host wrote.
  const withTail = chatRowOf(
    chat("routine-job-1-cron_2", 400, { routine: true, line: "Said by the delivery" }),
    said("A message nobody wrote", 900),
  )
  assert.equal(withTail.line, "Said by the delivery")
  assert.equal(withTail.at, 400)
  assert.equal(chatRowOf(chat("a", 100)).routine, undefined, "a chat is not a run")
})

test("a search keeps a chat whose title or last line it finds, in the list's own order", () => {
  const rows = [
    chatRowOf(chat("one", 300, { title: "Trip to Lisbon" }), said("Booked the flights", 300)),
    chatRowOf(chat("two", 200, { title: "Dinner" }), said("We said eight", 200)),
    chatRowOf(chat("three", 100, { title: "Plans" }), said("See you then", 100)),
  ]
  assert.deepEqual(
    chatList(rows, "lisbon").map((row) => row.id),
    ["one"],
    "a title is searched",
  )
  assert.deepEqual(
    chatList(rows, "said eight").map((row) => row.id),
    ["two"],
    "and so is the line under it",
  )
  assert.deepEqual(
    chatList(rows, "plan").map((row) => row.id),
    ["three"],
    "a title's own letters are enough",
  )
  assert.deepEqual(
    chatList(rows, "").map((row) => row.id),
    ["one", "two", "three"],
    "an empty search keeps the list as it stands",
  )
  assert.deepEqual(chatList(rows, "zebra"), [], "and nothing matches what is not there")
})

test("a search never re-orders the rows it keeps", () => {
  const rows = [
    chatRowOf(chat("a", 50, { pinned: true, title: "Pinned plan" })),
    chatRowOf(chat("b", 300, { title: "Plan" })),
  ]
  assert.deepEqual(
    chatList(rows, "plan").map((row) => row.id),
    ["a", "b"],
    "the pinned row is still on top of the rows the search kept",
  )
})

test("a row's age says how long ago today, and the date when that would not say it", () => {
  const now = Date.UTC(2026, 10, 10, 12)
  const today = chatAge(now - HOUR, now)
  const older = chatAge(now - 40 * DAY, now)
  assert.ok(today.length > 0, "a message from this morning reads as a time")
  assert.notEqual(today, older, "a message from weeks ago does not read the same")
  assert.ok(older.includes("2026"), "it names the date, so the year is not guessed at")
})
