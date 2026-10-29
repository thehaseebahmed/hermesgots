/** Which page of a transcript is read next, when the chat is whole, and how pages are joined. */
import assert from "node:assert/strict"
import test from "node:test"

import { foldTurns } from "../src/chat-next/fold.ts"
import {
  isLast,
  joinAt,
  newestRead,
  nextOffset,
  overlay,
  originOf,
  PAGE,
  prepend,
  shift,
  uniq,
} from "../src/chat-next/pages.ts"

const row = (id) => ({
  id,
  role: id % 2 ? "user" : "assistant",
  content: `row ${id}`,
  finish_reason: id % 2 ? null : "stop",
})
const ids = (rows) => rows.map((one) => one.id)
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, at) => row(from + at))

test("a page is the last one when it comes back short", () => {
  assert.equal(isLast(range(1, PAGE)), false)
  assert.equal(isLast(range(1, PAGE - 1)), true)
  assert.equal(isLast([]), true, "a chat the host has no rows for is whole")
})

test("the next page is read from as many rows as are held", () => {
  assert.equal(nextOffset([]), 0)
  assert.equal(nextOffset(range(1, 120)), 120)
})

test("with nothing held, the first page is the read: it is drawn at once and older rows are left", () => {
  const page = range(71, 120)
  assert.deepEqual(newestRead([page]), { rows: page, more: true, joined: false })
  assert.deepEqual(newestRead([page], []), { rows: page, more: true, joined: false })
})

test("a short first page is the whole chat", () => {
  const page = range(1, 20)
  assert.deepEqual(newestRead([page]), { rows: page, more: false, joined: false })
})

test("a page that joins the held rows ends the read, and the held rows below it stay", () => {
  const held = range(1, 120)
  const read = newestRead([range(71, 120)], held)
  assert.equal(read.joined, true)
  assert.deepEqual(ids(read.rows), ids(range(71, 120)), "the rows read, to lay over the held ones")
  assert.deepEqual(ids(overlay(held, read.rows)), ids(held))
  assert.equal(read.more, undefined, "whether older rows are left is as the device knew it")
})

test("a page that does not join the held rows asks for the next older one", () => {
  const held = range(1, 120)
  // Sixty rows written since: the newest page starts above the held rows' end.
  assert.equal(newestRead([range(81, 130)], held), undefined)
  const read = newestRead([range(31, 80), range(81, 130)], held)
  assert.deepEqual(ids(overlay(held, read.rows)), ids(range(1, 130)))
})

test("a page that sits in the held rows but does not match them from there on does not join", () => {
  const held = [...range(1, 100), row(101)]
  // Row ids 71..120 against held ids that stop at 101.
  assert.equal(joinAt(held, range(71, 120)), -1)
  assert.equal(joinAt(held, range(52, 101)), 51)
})

test("held rows that the host no longer has are read over, to the start of the chat", () => {
  const held = range(1000, 1119)
  const pages = [range(71, 120)]
  assert.equal(newestRead(pages, held), undefined)
  pages.unshift(range(21, 70))
  assert.equal(newestRead(pages, held), undefined)
  pages.unshift(range(1, 20))
  const read = newestRead(pages, held)
  assert.deepEqual(ids(read.rows), ids(range(1, 120)))
  assert.equal(read.more, false)
})

test("a read lands on the rows held when it lands, not the ones held when it began", () => {
  const read = range(71, 130)
  // An older page was put above the held rows while the read was out.
  const held = range(21, 120)
  assert.deepEqual(ids(overlay(held, read)), ids(range(21, 130)))
  assert.equal(overlay(range(1000, 1050), read), undefined, "rows replaced since are not continued")
})

test("a row that came twice because the pages slid is kept once, where it first stands", () => {
  assert.deepEqual(ids(uniq([row(1), row(2), row(2), row(3)])), [1, 2, 3])
  assert.deepEqual(ids(newestRead([range(51, 100), range(81, 130)]).rows), ids(range(51, 130)))
})

test("an older page goes above the rows held, and rows it shares with them are not drawn twice", () => {
  const held = range(71, 120)
  assert.deepEqual(ids(prepend(held, range(21, 70))), ids(range(21, 120)))
  // Ten rows were written while it was read, so it ends on ten rows the thread already holds.
  assert.deepEqual(ids(prepend(held, range(31, 80))), ids(range(31, 120)))
  assert.equal(prepend(held, range(71, 80)), held, "nothing new is the very rows held")
})

test("a reply whose request is in an older page is drawn alone, and whole once the page lands", () => {
  // Rows 71..120 open on a reply: its request, row 69, is in the page not read yet.
  const newest = [
    { id: 70, role: "assistant", content: "the end of an answer", finish_reason: "stop" },
    row(71),
    row(72),
  ]
  const alone = foldTurns(newest, true)
  assert.equal(alone.length, 2)
  assert.equal(alone[0].cut, true)
  assert.equal(alone[0].user, "")
  assert.equal(alone[0].row, undefined)
  assert.deepEqual(alone[0].parts, [{ kind: "text", text: "the end of an answer" }])
  assert.equal(alone[0].done, true, "an earlier turn is finished by what follows it")
  assert.equal(foldTurns(newest).length, 1, "a whole transcript drops a reply before any request")

  const whole = foldTurns([{ id: 69, role: "user", content: "the question" }, ...newest], true)
  assert.equal(whole.length, 2)
  assert.equal(whole[0].user, "the question")
  assert.equal(whole[0].row, 69)
  assert.equal(whole[0].cut, undefined)
  assert.deepEqual(whole[0].parts, alone[0].parts)
})

test("a page of calls and results with no request in it draws no empty turn", () => {
  const calls = [
    { id: 1, role: "tool", tool_call_id: "x", content: "result" },
    { id: 2, role: "user", content: "next" },
  ]
  const turns = foldTurns(calls, true)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user, "next")
})

test("turns keep their place when older turns are added above, and when newer ones are added below", () => {
  const turn = (at) => ({ row: at, user: `q${at}`, parts: [], done: true, delivered: [] })
  const first = { turns: [turn(5), turn(7)], origin: 0 }
  const above = [turn(1), turn(3), turn(5), turn(7)]
  assert.equal(shift(first.turns, above), 2)
  assert.equal(originOf(first, above), -2, "the held turns keep their ids, the new ones count down")
  const below = [turn(5), turn(7), turn(9)]
  assert.equal(shift(first.turns, below), 0)
  assert.equal(originOf(first, below), 0)
  // The first held turn is a reply with no request of its own: a later row-bearing turn says where.
  const cut = { turns: [{ ...turn(0), row: undefined, cut: true }, turn(5)], origin: 3 }
  assert.equal(
    originOf(cut, [turn(1), turn(3), turn(4), turn(5)]),
    1,
    "row 5 keeps the id 4 it had",
  )
  // Nothing in common: the count goes on.
  assert.equal(originOf(first, [turn(11)]), 0)
})
