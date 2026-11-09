/**
 * A point, read out of a message: the canvas's chat adds one marker line per element the reader
 * tapped, so the model reads the label and the selector while the thread draws a chip (ADR 0116).
 * The marker is a token pair rather than a field the host stores — the transcript keeps a message's
 * text and nothing else — so a line a person might have typed must stay words.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { pointIn, pointLine, pointText, pointsIn } from "../src/lib/point-marker.ts"

const TOTAL = { label: "Total", selector: "#total" }
const TIP = { label: "The tip row", selector: "section.tip > span:nth-of-type(2)" }

test("a marker round-trips and typed lookalike text stays words", () => {
  // A point is a line, and the line says both things the model reads.
  assert.equal(pointLine(TOTAL), "[POINT — Total | selector: #total]")
  assert.deepEqual(pointIn(pointLine(TOTAL)), TOTAL)
  assert.deepEqual(pointIn(pointLine(TIP)), TIP)
  // A label carrying the marker's own words still round-trips: the separator is taken last.
  const quoted = { label: 'A row saying "b | selector: c"', selector: "#row" }
  assert.deepEqual(pointIn(pointLine(quoted)), quoted)

  // A message carries the words, then a marker line per point.
  assert.equal(pointText("Make this bolder", [TOTAL]), "Make this bolder\n[POINT — Total | selector: #total]")
  assert.deepEqual(pointsIn(pointText("Make this bolder", [TOTAL])), {
    text: "Make this bolder",
    points: [TOTAL],
  })
  assert.deepEqual(pointsIn(pointText("Compare these", [TOTAL, TIP])), {
    text: "Compare these",
    points: [TOTAL, TIP],
  })
  // A message that only points at something is all marker, and no words.
  assert.deepEqual(pointsIn(pointText("", [TOTAL])), { text: "", points: [TOTAL] })
  // A message with nothing to read back is the message itself.
  assert.deepEqual(pointsIn("Just words"), { text: "Just words", points: [] })
  assert.deepEqual(pointsIn(""), { text: "", points: [] })

  // Nothing that isn't the exact pair, where the points sit, is a point: a message keeps its words.
  for (const typed of [
    "I typed [POINT — Total | selector: #total] in a sentence",
    "[POINT — Total | selector: #total] and then words after it",
    "[POINT — Total]",
    "[POINT — | selector: #total]",
    "[POINT — Total | selector: ]",
    "[POINT Total | selector: #total]",
    "POINT — Total | selector: #total",
    "[POINT — Total | selector: #total",
    "> [POINT — Total | selector: #total]",
  ])
    assert.deepEqual(pointsIn(typed), { text: typed, points: [] }, typed)
  // A marker line under the words is a point; the same line under other markers still is.
  assert.deepEqual(pointsIn(`${pointLine(TOTAL)}\nand words`), {
    text: `${pointLine(TOTAL)}\nand words`,
    points: [],
  })
})
