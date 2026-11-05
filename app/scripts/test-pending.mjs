/**
 * The queue Hermes itself holds for a session, as the chat draws it (`pending.ts`): what waits in it
 * and which row a restart left unfinishable. A queue with nothing lost draws nothing — its messages
 * are already in the thread, waiting their turn — and the host names the one row that holds the rest.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_TEXT,
  LOST_LABEL,
  WAITING_LABEL,
  pausedQueue,
  rowLine,
  sameQueue,
} from "../src/lib/pending.ts"

const held = {
  items: [
    { id: "a", text: "a turn lost when the server went down" },
    { id: "b", text: "the older message behind it" },
  ],
  lost: "a",
}

test("the row the host names as lost reads as lost, and everything behind it waits", () => {
  const card = pausedQueue(held)
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

test("a queue with nothing lost draws no card: its messages are in the thread", () => {
  assert.equal(pausedQueue({ items: held.items, lost: null }), undefined)
  assert.equal(pausedQueue({ items: [], lost: null }), undefined)
  assert.equal(pausedQueue(undefined), undefined)
})

test("a fence with nothing behind it still draws the card", () => {
  const card = pausedQueue({ items: [held.items[0]], lost: "a" })
  assert.equal(card?.rows.length, 1)
})

test("the card is drawn from the row that was lost, not from a later one that also can't finish", () => {
  // Two rows the host can't vouch for: the one it names holds the queue, and the other waits its turn
  // behind it rather than claiming the queue too.
  const card = pausedQueue({
    items: [held.items[0], { id: "later", text: "another lost turn" }],
    lost: "a",
  })
  assert.deepEqual(
    card?.rows.map((row) => row.state),
    ["lost", "waiting"],
  )
})

test("a read that says the same thing as the last one changes nothing", () => {
  const copy = { items: held.items.map((item) => ({ ...item })), lost: "a" }
  assert.ok(sameQueue(held, copy), "the same words, in the same order, are the same answer")
  assert.ok(sameQueue(undefined, undefined))
  assert.ok(!sameQueue(undefined, held))
  assert.ok(!sameQueue(held, { ...held, lost: null }))
  assert.ok(!sameQueue(held, { ...held, items: held.items.slice(0, 2).reverse() }))
  assert.ok(
    !sameQueue(held, {
      ...held,
      items: [{ ...held.items[0], text: "reworded" }, held.items[1]],
    }),
  )
})

test("a row shows its message on one line, or says it has none", () => {
  assert.equal(rowLine("  two\n\nlines  "), "two lines")
  assert.equal(rowLine(""), EMPTY_TEXT)
  assert.equal(rowLine("   \n "), EMPTY_TEXT)
  assert.ok(rowLine("a".repeat(500)).length <= 200, "a long message is cut to the row's line")
})
