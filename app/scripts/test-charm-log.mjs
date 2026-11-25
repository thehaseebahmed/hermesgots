/**
 * The charm's log, read past the window it happens to hold: the ask that names a row's own index,
 * and the page it is answered with — the base its rows really begin at, and rows in `LogTail`'s own
 * bytes. Pure, so what goes over the link is read as bytes here against the firmware's
 * `docs/PROTOCOL.md`, and a page read by one reader cannot drift from the other op's.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  CHARM_VERSION,
  CharmOp,
  logSinceMessage,
  parseLogPage,
  parseLogSince,
} from "../src/lib/charm-protocol.ts"

const encoder = new TextEncoder()

/** A row as both pages write it: `[flags u8][len u8][text]`, bit 0 saying it carries a line on. */
function row(text, carried = false) {
  const bytes = encoder.encode(text)
  return [carried ? 1 : 0, bytes.length, ...bytes]
}

/** A status frame as the charm notifies one: `[version][code][op][needImage][extraLen][extra]`. */
function frame(op, extra) {
  return new Uint8Array([CHARM_VERSION, 0, op, 0, extra.length, ...extra])
}

/** A frame as a link hands it over, over bytes of its own so a cut one cannot reach back. */
const view = (bytes) => new DataView(new Uint8Array(bytes).buffer)

/** `[base u32 LE][count u8]`, then the rows, as the charm answers `LogSince`. */
const sincePage = (base, rows) => [
  base & 0xff,
  (base >>> 8) & 0xff,
  (base >>> 16) & 0xff,
  (base >>> 24) & 0xff,
  rows.length,
  ...rows.flat(),
]

/** `[total u16 BE][from u16 BE][count u8]`, then the same rows, as it answers `LogTail`. */
const tailPage = (total, from, rows) => [
  (total >> 8) & 0xff,
  total & 0xff,
  (from >> 8) & 0xff,
  from & 0xff,
  rows.length,
  ...rows.flat(),
]

test("LogSince goes out as the row's index", () => {
  assert.equal(CharmOp.LogSince, 0x45)
  // [version][op][from u32]: the index is four bytes and little-endian, like every other u32 on this
  // wire, so 0x00010002 goes out low byte first rather than the other way about.
  assert.deepEqual(
    [...logSinceMessage(0x00010002)],
    [CHARM_VERSION, CharmOp.LogSince, 0x02, 0x00, 0x01, 0x00],
  )
  assert.deepEqual([...logSinceMessage(0)], [CHARM_VERSION, CharmOp.LogSince, 0, 0, 0, 0])
})

test("a page is read from its base, and a short one is refused", () => {
  const rows = [row("E (1041) talk: no capture"), row("task at all", true)]
  const page = frame(CharmOp.LogSince, sincePage(0x00010002, rows))
  assert.deepEqual(parseLogSince(view(page)), {
    base: 0x00010002,
    rows: [
      { text: "E (1041) talk: no capture", carried: false },
      { text: "task at all", carried: true },
    ],
  })
  // A page with no rows still names a base: it is where the next ask goes, and where a phone learns
  // the charm counted from zero again.
  assert.deepEqual(parseLogSince(view(frame(CharmOp.LogSince, sincePage(11, [])))), {
    base: 11,
    rows: [],
  })
  // Short of its own header: the five bytes naming the frame, four of base and a count.
  assert.equal(parseLogSince(view(page.slice(0, 9))), null)
  // Its extra cut before the base finished arriving, so no base can be read and none is guessed.
  assert.equal(parseLogSince(view(page.slice(0, 12))), null)
  // Another op's answer, which names itself in the third byte.
  assert.equal(parseLogSince(view(frame(CharmOp.LogTail, sincePage(3, rows)))), null)
  // A row longer than the bytes the extra holds: the page is refused whole, never half of it.
  assert.equal(parseLogSince(view(frame(CharmOp.LogSince, sincePage(0, [[0, 40, 0x41]])))), null)
})

test("a row the parser cannot bound ends the page rather than half of it", () => {
  // The first row reads whole and the second claims twenty-six bytes where three remain: a page
  // handed back with only the first would be a page the charm never sent. Beside it the same two
  // rows, both bounded, read as two.
  const whole = [row("boot: 0.2.1"), row("E (1041) talk")]
  const cut = [row("boot: 0.2.1"), [0, 26, 0x45]]
  assert.deepEqual(parseLogSince(view(frame(CharmOp.LogSince, sincePage(7, whole))))?.rows, [
    { text: "boot: 0.2.1", carried: false },
    { text: "E (1041) talk", carried: false },
  ])
  assert.equal(parseLogSince(view(frame(CharmOp.LogSince, sincePage(7, cut)))), null)
  // `LogTail` reads its rows through the same reader, so it refuses the same page the same way.
  assert.equal(parseLogPage(view(frame(CharmOp.LogTail, tailPage(12, 0, cut)))), null)
})

test("LogTail and LogSince read their rows the same way", () => {
  const rows = [row("boot: 0.2.1"), row("E (1041) talk: no capture "), row("task at all", true)]
  const tail = parseLogPage(view(frame(CharmOp.LogTail, tailPage(9, 4, rows))))
  const since = parseLogSince(view(frame(CharmOp.LogSince, sincePage(4, rows))))
  // One reader: the same row bytes are the same rows, the carried flag and its text included.
  assert.deepEqual(since?.rows, tail?.rows)
  assert.deepEqual(tail?.rows, [
    { text: "boot: 0.2.1", carried: false },
    { text: "E (1041) talk: no capture ", carried: false },
    { text: "task at all", carried: true },
  ])
  // Only the coordinate differs: a place among the kept rows against a row's own index.
  assert.equal(tail?.from, 4)
  assert.equal(tail?.total, 9)
  assert.equal(since?.base, 4)
})
