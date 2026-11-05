/**
 * The queue Hermes itself holds for a session, as the chat draws it (`pending.ts`): what waits in it
 * and which row a restart left unfinishable. A queue with nothing lost draws nothing — its messages
 * are already in the thread, waiting their turn — and the host names the one row that holds the rest.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { EMPTY_TEXT, ROW_LABEL, pausedQueue, rowLine } from "../src/lib/pending.ts"

const held = {
  items: [
    { id: "a", text: "a turn lost when the server went down" },
    { id: "b", text: "the older message behind it" },
  ],
  lost: "a",
  running: false,
}

test("the row the host names as lost reads as lost, and everything behind it waits", () => {
  const card = pausedQueue(held)
  assert.ok(card)
  assert.equal(card.lost, "a")
  assert.deepEqual(
    card.rows.map((row) => [row.id, row.state, ROW_LABEL[row.state]]),
    [
      ["a", "lost", ROW_LABEL.lost],
      ["b", "waiting", ROW_LABEL.waiting],
    ],
  )
  assert.equal(card.rows[0].text, "a turn lost when the server went down")
})

test("a queue with nothing lost draws no card: its messages are in the thread", () => {
  assert.equal(pausedQueue({ items: held.items, lost: null, running: false }), undefined)
  assert.equal(pausedQueue({ items: [], lost: null, running: true }), undefined)
  assert.equal(pausedQueue(undefined), undefined)
})

test("a fence with nothing behind it still draws the card", () => {
  const card = pausedQueue({ items: [held.items[0]], lost: "a", running: false })
  assert.equal(card?.rows.length, 1)
})

test("the card is drawn from the row that was lost, not from a later one that also can't finish", () => {
  // Two rows the host can't vouch for: the one it names holds the queue, and the other waits its turn
  // behind it rather than claiming the queue too.
  const card = pausedQueue({
    items: [held.items[0], { id: "later", text: "another lost turn" }],
    lost: "a",
    running: false,
  })
  assert.deepEqual(
    card?.rows.map((row) => row.state),
    ["lost", "waiting"],
  )
})

test("a row shows its message on one line, or says it has none", () => {
  assert.equal(rowLine("  two\n\nlines  "), "two lines")
  assert.equal(rowLine(""), EMPTY_TEXT)
  assert.equal(rowLine("   \n "), EMPTY_TEXT)
  assert.ok(rowLine("a".repeat(500)).length <= 200, "a long message is cut to the row's line")
})
