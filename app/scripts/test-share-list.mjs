/**
 * The share sheet's rows as a rule: which conversations of a bot are offered, how long a row has to
 * have been touched to be one, the order they are drawn in and the hard limit on how many. The
 * screen draws exactly this (`routes/share.tsx`), so a window, an order or a dropped row that went
 * wrong is read here, with a seeded record and no DOM (AGENTS.md's unit tier).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { recentTargets, SHARE_MOST, SHARE_WINDOW_MS } from "../src/lib/share-list.ts"

const HOUR = 3_600_000

/** A conversation's record, as the sheet's read hands it to the rule. */
const chat = (id, at, patch = {}) => ({ id, title: `Chat ${id}`, updatedAt: at, ...patch })

const NOW = Date.UTC(2026, 10, 11, 12)

test("a chat and a code session from the last week are offered, and one a moment past it is not", () => {
  const rows = recentTargets(
    [
      chat("chat", NOW - HOUR),
      chat("session", NOW - HOUR, { projectId: "project-1" }),
      chat("edge", NOW - SHARE_WINDOW_MS),
      chat("past", NOW - SHARE_WINDOW_MS - 1),
    ],
    NOW,
  )
  assert.deepEqual(
    rows.map((row) => [row.id, row.kind]),
    [
      ["chat", "chat"],
      ["session", "session"],
      ["edge", "chat"],
    ],
    "the week's chats and code sessions are offered, and the window's own edge is inside it",
  )
  assert.equal(rows[0].title, "Chat chat", "a row carries the record's title")
  assert.equal(rows[0].at, NOW - HOUR, "and the clock that placed it")
  assert.equal(
    rows.some((row) => row.id === "past"),
    false,
    "a row a millisecond past the week is not offered",
  )
})

test("a canvas's chat, a room and a discarded session are not rows of the sheet", () => {
  const rows = recentTargets(
    [
      chat("chat", NOW - HOUR),
      chat("canvas", NOW - HOUR, { canvasId: "canvas-1" }),
      chat("room", NOW - HOUR, { room: { id: "room-1", members: [] } }),
      chat("discarded", NOW - HOUR, { projectId: "project-1", discardedAt: NOW - HOUR }),
    ],
    NOW,
  )
  assert.deepEqual(
    rows.map((row) => row.id),
    ["chat"],
    "a canvas is its own screen's, a room is its own row, and a discarded session is out",
  )
})

test("a week of thirty rows is offered as twenty-five", () => {
  const rows = recentTargets(
    Array.from({ length: 30 }, (_, index) => chat(`row-${index}`, NOW - index * 60_000)),
    NOW,
  )
  assert.equal(rows.length, SHARE_MOST, "the sheet's hard limit")
  assert.equal(rows.length, 25, "twenty-five rows")
  assert.equal(rows[0].id, "row-0", "the newest is kept")
  assert.equal(rows.at(-1).id, "row-24", "and the limit keeps the twenty-five newest")
})

test("the newest row comes first, and two touched at one moment keep one order", () => {
  const rows = recentTargets(
    [
      chat("b", NOW - HOUR),
      chat("a", NOW - HOUR),
      chat("newest", NOW - 60_000),
      chat("oldest", NOW - 2 * HOUR),
    ],
    NOW,
  )
  assert.deepEqual(
    rows.map((row) => row.id),
    ["newest", "a", "b", "oldest"],
    "newest first, and a tie by id so every device draws them alike",
  )
})
