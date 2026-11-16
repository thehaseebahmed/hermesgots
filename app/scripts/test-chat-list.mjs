/**
 * A bot's chat list as a rule: what one row says, the order the rows are drawn in, and what a search
 * keeps. The screen draws exactly this (`routes/bot-chats.tsx`), so an ordering, a line or a search
 * that went wrong is read here, with a seeded row and no DOM (AGENTS.md's unit tier).
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  chatAge,
  chatList,
  chatRowOf,
  CHAT_FILTERS,
  filterChatRows,
  orderChatRows,
  PIN_LIMIT,
  pinsOf,
  pinSwitchOf,
} from "../src/lib/chat-list.ts"
import { roomRowOf } from "../src/lib/rooms.ts"

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

test("a row says what the reader was told, and is placed by when it was told", () => {
  // The reader spoke last: the row's line is the bot's, and so is its clock — what the reader typed
  // is not news to them, and a chat is as new as the last thing received in it.
  const mine = said("now do the next thing please", 300, { role: "user" })
  const told = said("The build is green.", 240)
  const row = chatRowOf(chat("a", 100), mine, told)
  assert.equal(row.line, "The build is green.", "the line is the last thing received")
  assert.equal(row.at, 240, "and the row is ordered by when that arrived, not by the reply to it")
  // Two chats whose newest messages are both the reader's own, in the opposite order to the bot's:
  // the one the reader wrote in last is not the one above, since nothing has arrived in it since.
  const rows = [
    chatRowOf(
      chat("spoken-in-last", 100),
      said("a note", 500, { role: "user" }),
      said("said first", 200),
    ),
    chatRowOf(
      chat("answered-last", 100),
      said("a note", 250, { role: "user" }),
      said("said last", 400),
    ),
  ]
  assert.deepEqual(
    orderChatRows(rows).map((row) => row.id),
    ["answered-last", "spoken-in-last"],
    "the chat the bot answered most recently stands first",
  )
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

test("a chat nothing has been said in says so, and keeps its own clock", () => {
  const row = chatRowOf(chat("a", 100))
  assert.equal(row.line, "No messages yet", "nothing said yet, and the row says it rather than nothing")
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

test("the pinned group keeps the order its pins were made, so the last pin sits at the bottom", () => {
  // A pin's place among the pins is the moment it was made, not what was last said in it: the row
  // pinned first stays on top even where another pinned row has been spoken in far more recently.
  const rows = [
    chatRowOf(chat("pinned-last", 900, { pinned: true, pinnedAt: 300 })),
    chatRowOf(chat("pinned-first", 100, { pinned: true, pinnedAt: 100 })),
    chatRowOf(chat("pinned-second", 700, { pinned: true, pinnedAt: 200 })),
    chatRowOf(chat("unpinned", 800)),
  ]
  assert.deepEqual(
    orderChatRows(rows).map((row) => row.id),
    ["pinned-first", "pinned-second", "pinned-last", "unpinned"],
    "the earliest pin is on top and the last pin is at the bottom of the pinned group",
  )
})

test("a row with no `pinnedAt` stands above one pinned later", () => {
  // Every pin written before the app kept the clock carries none, and must keep the top of the group
  // as the earliest rather than falling under every pin made since — which is what asks no migration.
  const rows = [
    chatRowOf(chat("pinned-yesterday", 900, { pinned: true, pinnedAt: 500 })),
    chatRowOf(chat("pinned-before-the-clock", 100, { pinned: true })),
  ]
  assert.deepEqual(
    orderChatRows(rows).map((row) => row.id),
    ["pinned-before-the-clock", "pinned-yesterday"],
    "a pin with no clock reads as the earliest, so it keeps the top of the group",
  )
})

test("two pins made at one moment fall back to the list's own order", () => {
  const tied = [
    chatRowOf(chat("quiet", 200, { pinned: true, pinnedAt: 500 })),
    chatRowOf(chat("busy", 300, { pinned: true, pinnedAt: 500 })),
  ]
  assert.deepEqual(
    orderChatRows(tied).map((row) => row.id),
    ["busy", "quiet"],
    "a tie on the moment falls back to the newest word said in them",
  )
  const same = [
    chatRowOf(chat("b", 200, { pinned: true, pinnedAt: 500 })),
    chatRowOf(chat("a", 200, { pinned: true, pinnedAt: 500 })),
  ]
  assert.deepEqual(
    orderChatRows(same).map((row) => row.id),
    ["a", "b"],
    "and one tied on both falls back to the id, so two devices draw one order",
  )
})

test("the unpinned band under the pins still reads newest first", () => {
  const rows = [
    chatRowOf(chat("unpinned-oldest", 100)),
    chatRowOf(chat("pin", 50, { pinned: true, pinnedAt: 10 })),
    chatRowOf(chat("unpinned-newest", 300)),
    chatRowOf(chat("unpinned-middle", 200)),
  ]
  assert.deepEqual(
    orderChatRows(rows).map((row) => row.id),
    ["pin", "unpinned-newest", "unpinned-middle", "unpinned-oldest"],
    "a pin's clock orders it among the pins only; the rows under them are still by their last word",
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

test("a row's line is the first line of a message's words, with its markdown taken out", () => {
  const cases = [
    ["**Done** and *done*", "Done and done"],
    ["`pnpm test` is green", "pnpm test is green"],
    ["See [the pull request](https://example.test/1) for it", "See the pull request for it"],
    ["# Plan\n\n**Step one**", "Plan"],
    ["- a bullet", "a bullet"],
    ["1. numbered", "numbered"],
    ["> quoted", "quoted"],
    ["~~gone~~ now", "gone now"],
    ["a \\* b", "a * b"],
    ["```ts\nconst x = 1\n```", "const x = 1"],
    ["![a chart](chart.png) says", "a chart says"],
    ["| a | b |\n| - | - |\n| 1 | 2 |", "a b"],
  ]
  for (const [text, words] of cases) {
    assert.equal(chatRowOf(chat("c", 1), said(text, 2)).line, words, text)
  }
})

test("a chat nothing has been said in says so, rather than drawing an empty line", () => {
  assert.equal(chatRowOf(chat("c", 1), said("", 2)).line, "No messages yet")
  assert.equal(chatRowOf(chat("c", 1)).line, "No messages yet")
})

/** A room's row, as the list reads one: its members' faces in place of a chat's icon. */
const roomRow = (id, at, patch = {}) => ({
  id,
  title: `Room ${id}`,
  at,
  pinned: false,
  room: { shown: ["a", "b"], more: 0 },
  ...patch,
})

test("a row carries its pin's clock and the archive mark from its record", () => {
  const row = chatRowOf(chat("a", 100, { pinned: true, pinnedAt: 700, archived: true }))
  assert.equal(row.pinnedAt, 700, "the row knows when it was pinned, which is what orders the pins")
  assert.equal(row.archived, true, "and whether it is archived, which is what the pill reads")
  assert.equal(chatRowOf(chat("b", 100)).archived, undefined, "a chat nobody archived carries nothing")
  assert.equal(chatRowOf(chat("c", 100)).pinnedAt, undefined, "and one nobody pinned no clock")

  // A run's row is the record's, mark and clock and all — the delivery is no different a row.
  const run = chatRowOf(
    chat("run", 300, { routine: true, line: "A delivery", pinned: true, pinnedAt: 20, archived: true }),
  )
  assert.equal(run.archived, true, "a routine's row carries the archive mark too")
  assert.equal(run.pinnedAt, 20, "and its pin's clock")

  const room = roomRowOf(
    { id: "r", title: "A room", updatedAt: 5, pinned: true, pinnedAt: 40, archived: true },
    { shown: [], more: 0 },
  )
  assert.equal(room.archived, true, "and so does a room's, off the record's own fields")
  assert.equal(room.pinnedAt, 40)
})

test("a list's pins are the rows that carry one, and five is the most it holds", () => {
  const rows = [
    chatRowOf(chat("pin-a", 100, { pinned: true, pinnedAt: 10 })),
    chatRowOf(chat("plain", 200)),
    roomRow("pin-room", 400, { pinned: true, pinnedAt: 20 }),
    chatRowOf(chat("pin-b", 300, { pinned: true })),
  ]
  assert.equal(PIN_LIMIT, 5, "five pins in one bot's list")
  assert.deepEqual(
    pinsOf(rows).map((row) => row.id),
    ["pin-a", "pin-room", "pin-b"],
    "a room's pin counts with the chats' pins, and the rows keep the order they came in",
  )
  assert.deepEqual(pinsOf([chatRowOf(chat("only", 1))]), [], "and a list with no pins holds none")
})

test("the sixth pin's switch is off and says why, and a pinned row can always be unpinned", () => {
  const pins = [1, 2, 3, 4, 5].map((n) =>
    chatRowOf(chat(`pin-${n}`, 100 + n, { pinned: true, pinnedAt: n })),
  )
  const sixth = chatRowOf(chat("sixth", 900))
  const rows = [...pins, sixth]

  const off = pinSwitchOf(sixth, rows)
  assert.equal(off.checked, false, "a row nobody pinned reads off")
  assert.equal(off.disabled, true, "and at five the switch will not be turned")
  assert.equal(
    off.subtitle,
    "Five pins is the most one list holds. Unpin one to make room.",
    "the line says the list holds five, and that one has to be unpinned first",
  )

  const on = pinSwitchOf(pins[0], rows)
  assert.equal(on.checked, true, "a pinned row reads on")
  assert.equal(on.disabled, false, "and can always be turned off, even at five")
  assert.equal(
    on.subtitle,
    "Stays at the top of its list, on every device.",
    "the line says what the switch does",
  )

  const room = pinSwitchOf(sixth, rows.slice(0, 4))
  assert.equal(room.checked, false)
  assert.equal(room.disabled, false, "below five the switch is offered")
  assert.equal(room.subtitle, "Stays at the top of its list, on every device.")
})

test("the three kinds of row partition the list, and each pill keeps its own", () => {
  const rows = [
    chatRowOf(chat("chat", 300)),
    roomRow("room", 200),
    chatRowOf(chat("run", 100, { routine: true })),
  ]
  const ids = (key) => filterChatRows(rows, key, {}).map((row) => row.id)
  assert.deepEqual(ids("all"), ["chat", "room", "run"], "All keeps the list as it stands")
  assert.deepEqual(ids("chats"), ["chat"], "a chat is neither a room nor a run")
  assert.deepEqual(ids("rooms"), ["room"])
  assert.deepEqual(ids("routines"), ["run"])
  assert.equal(
    ["chats", "rooms", "routines"].reduce((count, key) => count + ids(key).length, 0),
    rows.length,
    "and every row is exactly one of the three",
  )
})

test("Unread is the mark a row's dot reads, so a device that has read nothing has none", () => {
  const rows = [
    chatRowOf(chat("newer", 300)),
    chatRowOf(chat("older", 100)),
    roomRow("unmarked", 300),
  ]
  assert.deepEqual(
    filterChatRows(rows, "unread", { newer: 200, older: 400 }).map((row) => row.id),
    ["newer"],
    "activity newer than this device's mark is unread",
  )
  assert.deepEqual(
    filterChatRows(rows, "unread", {}).map((row) => row.id),
    [],
    "and a row this device never opened has no mark to be newer than",
  )
})

test("every pill says what it says when it keeps nothing", () => {
  const said = Object.fromEntries(CHAT_FILTERS.map((entry) => [entry.key, entry.empty]))
  assert.deepEqual(Object.keys(said), ["all", "unread", "chats", "rooms", "routines"])
  for (const [key, empty] of Object.entries(said)) {
    assert.ok(empty && empty.endsWith("."), `${key} has a sentence of its own`)
  }
  assert.equal(new Set(Object.values(said)).size, 5, "and no two pills say the same thing")
  assert.equal(said.all, "No chats yet.", "All's is the list's own emptiness")
})

test("a filter narrows before the search, so a search inside a pill finds only that pill's rows", () => {
  const rows = [
    chatRowOf(chat("trip", 300, { title: "Trip to Lisbon" })),
    roomRow("trip-room", 200, { title: "Trip room" }),
    chatRowOf(chat("dinner", 100, { title: "Dinner" })),
  ]
  assert.deepEqual(
    chatList(filterChatRows(rows, "rooms", {}), "trip").map((row) => row.id),
    ["trip-room"],
    "the room is the only row both keep",
  )
  assert.deepEqual(
    chatList(filterChatRows(rows, "chats", {}), "trip").map((row) => row.id),
    ["trip"],
    "and a pill with rows the words do not find is the search's emptiness, not the pill's",
  )
})
