/**
 * The queue Hermes itself holds for a session, as the chat draws it (`pending.ts`): what waits in it
 * and the turn a restart lost out from under them. A queue still moving draws nothing — its messages
 * are already in the thread, waiting their turn — and the card is the one place a reader sees what a
 * discard would set free.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_TEXT,
  LOST_LABEL,
  PAUSED_TITLE,
  WAITING_LABEL,
  pausedQueue,
  releasedBy,
  rowLine,
} from "../src/lib/pending.ts"

const paused = {
  items: [
    { id: "a", text: "a turn lost when the server went down", status: "unknown" },
    { id: "b", text: "the older message behind it", status: "queued" },
  ],
  lost: "a",
  paused: true,
}

test("a fence names the lost turn first and the messages it holds behind it", () => {
  const card = pausedQueue(paused)
  assert.ok(card)
  assert.equal(card.lost, "a")
  assert.deepEqual(
    card.rows.map((row) => [row.id, row.state, row.label]),
    [
      ["a", "lost", LOST_LABEL],
      ["b", "waiting", WAITING_LABEL],
    ],
  )
  assert.equal(card.rows[0].text, "a turn lost when the server went down")
})

test("a queue still moving draws no card: its messages are in the thread", () => {
  assert.equal(pausedQueue({ items: paused.items, lost: null, paused: false }), undefined)
  assert.equal(pausedQueue({ items: [], lost: null, paused: false }), undefined)
  assert.equal(pausedQueue(undefined), undefined)
})

test("a fence with nothing behind it still draws the card", () => {
  const card = pausedQueue({ items: [paused.items[0]], lost: "a", paused: true })
  assert.equal(card?.rows.length, 1)
})

test("the count is what a discard sets free, not the turn it throws away", () => {
  assert.equal(releasedBy(paused), 1)
  assert.equal(releasedBy({ items: [paused.items[0]], lost: "a", paused: true }), 0)
  assert.equal(releasedBy({ items: paused.items, lost: null, paused: false }), 0)
})

test("a row shows its message on one line, or says it has none", () => {
  assert.equal(rowLine("  two\n\nlines  "), "two lines")
  assert.equal(rowLine(""), EMPTY_TEXT)
  assert.equal(rowLine("   \n "), EMPTY_TEXT)
  assert.ok(rowLine("a".repeat(500)).length <= 200, "a long message is cut to the row's line")
})

test("the card says what paused it, in the reader's words", () => {
  assert.match(PAUSED_TITLE, /queue is paused/i)
})
