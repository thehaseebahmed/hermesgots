/**
 * The charm's log kept as a book: the rows a reader has already taken, each at the index the charm
 * numbered it with, folded back into the lines the panel wrapped and capped at the newest thousand.
 * Pure, so this drives the whole rule — the row still being printed, a line the charm repeated, the
 * ring dropping rows the book never read, a reboot starting the count again, and the cap — with no
 * radio, no screen and no store.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { KEPT, lines, place, text } from "../src/lib/charm-book.ts"

/** A row as the charm prints it: its text, and whether it carries the line above it on. */
const row = (text, carried = false) => ({ text, carried })

/** A page as `LogSince` answers it: where its rows really begin, and the rows themselves. */
const page = (base, rows) => ({ base, rows })

/** A book holding nothing yet, asking from the start of the charm's count. */
const EMPTY = { rows: [], next: 0 }

test("a row the book holds grows where it stands", () => {
  const first = place(EMPTY, page(12, [row("op 0x44"), row("att_handle=2")]))
  const grown = place(first, page(12, [row("op 0x44"), row("att_handle=20"), row("code 0")]))
  assert.deepEqual(lines(grown), ["op 0x44", "att_handle=20", "code 0"])
  assert.equal(grown.rows.length, 3, "the row the charm grew is held once, not twice")
  assert.equal(grown.next, 14, "the next ask starts from the last row the book holds, not past it")
  assert.deepEqual(
    lines(first),
    ["op 0x44", "att_handle=2"],
    "placing a page leaves the book it read",
  )
})

test("a repeated row is not a second line", () => {
  const said = "att_handle=20, op 0x44 -> code 0"
  const held = place(place(EMPTY, page(30, [row(said)])), page(31, [row(said)]))
  assert.equal(held.rows.length, 2, "both are the charm's rows, each at its own index")
  assert.deepEqual(
    lines(held),
    [said, said],
    "the charm printed the line twice, so the book draws it twice",
  )
})

test("the panel's wrap is one line again", () => {
  const whole = "the charm keeps the last few seconds of its log in a ring of seventy rows"
  const wrapped = whole.match(/.{1,26}/g)
  assert.equal(wrapped.length, 3, "a line the twenty-six-column panel wrapped over three rows")
  const held = place(
    EMPTY,
    page(
      5,
      wrapped.map((piece, at) => row(piece, at > 0)),
    ),
  )
  assert.deepEqual(lines(held), [whole], "the rows are fragments of one line, not three")
  assert.doesNotMatch(lines(held)[0], /\n/, "nothing is put between the fragments")
})

test("a page that does not follow the book's last row starts a new line", () => {
  const held = place(
    place(EMPTY, page(41, [row("E (1041) talk: no capture task at all")])),
    page(60, [row(" with a wrapped tail", true), row("and the next")]),
  )
  assert.deepEqual(
    lines(held),
    ["E (1041) talk: no capture task at all", " with a wrapped tail", "and the next"],
    "the ring dropped the rows between, so the page's first row cannot finish the line before it",
  )
  assert.equal(held.rows.length, 3, "the hole is not marked, and nothing already read is dropped")
  assert.equal(held.next, 61)
})

test("a row that is not the next index never carries a line on", () => {
  const held = place(
    place(EMPTY, page(3, [row("the line before the hole")])),
    page(6, [row(" a tail", true)]),
  )
  assert.deepEqual(lines(held), ["the line before the hole", " a tail"])
})

test("a book that begins mid-line starts a line of its own", () => {
  const held = place(EMPTY, page(19, [row("held over from a row it never read", true)]))
  assert.deepEqual(lines(held), ["held over from a row it never read"])
})

test("a page whose base is behind the book's own means the charm's count began again", () => {
  const first = place(EMPTY, page(88, [row("boot: 1"), row("log armed: 41 rows")]))
  const rebooted = place(first, page(3, []))
  assert.deepEqual(
    lines(rebooted),
    ["boot: 1", "log armed: 41 rows"],
    "the lines it read stay, since a count that went backwards can only be a boot",
  )
  assert.equal(rebooted.next, 3, "and the next ask counts from where the new run began")
  const joined = place(rebooted, page(3, [row("boot: 2"), row(" still booting", true)]))
  assert.deepEqual(lines(joined), ["boot: 1", "log armed: 41 rows", "boot: 2 still booting"])
  const grown = place(
    joined,
    page(3, [row("boot: 2"), row(" still booting", true), row("and ready")]),
  )
  assert.equal(grown.rows.length, 5, "the lines from before the boot are still held")
  assert.deepEqual(
    lines(grown),
    ["boot: 1", "log armed: 41 rows", "boot: 2 still booting", "and ready"],
    "and the new run is replaced where it stands, like any other",
  )
})

test("the oldest lines go past the cap and are trimmed whole", () => {
  let held = EMPTY
  let at = 0
  const printed = KEPT + 40
  while (at < printed) {
    const rows = Array.from({ length: 5 }, (_, step) => row(`line ${at + step}`))
    held = place(held, page(at, rows))
    at += 5
  }
  const drawn = lines(held)
  assert.equal(drawn.length, KEPT, "the book keeps the newest thousand lines")
  assert.equal(drawn[0], "line 40", "the oldest forty lines are gone to their own row")
  assert.equal(drawn.at(-1), `line ${printed - 1}`)
})

test("a wrapped line is trimmed whole, never cut into a tail", () => {
  let held = EMPTY
  let line = 0
  for (let pageAt = 0; pageAt < 210; pageAt++) {
    const rows = []
    const base = line * 2
    for (let step = 0; step < 5; step++, line++)
      rows.push(row(`line ${line} `), row("wrapped", true))
    held = place(held, page(base, rows))
  }
  const drawn = lines(held)
  assert.equal(drawn.length, KEPT)
  assert.equal(drawn[0], "line 50 wrapped", "the rows of a trimmed line go with it")
})

test("the copied block is the lines and nothing else", () => {
  const held = place(
    place(EMPTY, page(0, [row("boot: 1"), row("log armed: 41 rows")])),
    page(2, [row("att_handle=20, op 0x44 -> code 0")]),
  )
  assert.equal(text(held), lines(held).join("\n"), "a line per line, oldest first")
  assert.equal(text(held), "boot: 1\nlog armed: 41 rows\natt_handle=20, op 0x44 -> code 0")
  assert.equal(text(held).split("\n").length, 3, "no header above and nothing below")
  assert.equal(text(EMPTY), "", "a book holding nothing copies as nothing")
})
