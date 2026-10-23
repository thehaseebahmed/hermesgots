/**
 * The chart's axis rule, on its own: which values a y axis carries for a set of points, and how wide
 * the axis has to be for the labels it draws. A chart draws these numbers as its ticks, so the width
 * comes from the labels rather than a constant — a five-digit value at a phone's width has to stay
 * whole.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { estimateWidth, yAxisOf, yAxisWidth } from "../src/lib/openui-chart.ts"

const width = (label) => label.length * 10

test("a five-digit series carries round ticks up to its top", () => {
  assert.deepEqual(
    yAxisOf([12400, 18300, 15900]),
    { domain: [0, 20000], ticks: [0, 5000, 10000, 15000, 20000] },
    "ticks a reader can hold: 0 to 20,000 in fives",
  )
})

test("a series that dips below zero keeps its ticks under it", () => {
  const { domain, ticks } = yAxisOf([-1200, 3400])
  assert.deepEqual(domain, [-2000, 4000], "the domain covers the dip and the peak")
  assert.deepEqual(ticks, [-2000, 0, 2000, 4000], "and every tick the axis draws")
})

test("a fractional range gets fractional ticks with no float dust", () => {
  assert.deepEqual(yAxisOf([0.1, 0.3]).ticks, [0, 0.1, 0.2, 0.3], "tenths, exactly")
})

test("a series with nothing in it still has an axis", () => {
  assert.deepEqual(yAxisOf([]).ticks, [0, 1], "an axis a chart can draw before data arrives")
})

test("every series the chart plots shares the one axis", () => {
  assert.deepEqual(
    yAxisOf([180, 40, 900]).domain,
    [0, 1000],
    "the axis covers the tallest point of either series",
  )
})

test("the axis is as wide as its widest label plus the room it keeps", () => {
  assert.equal(
    yAxisWidth(["0", "20000", "500"], width, 12, 32),
    62,
    "5 digits of 10px each, 12 of room",
  )
  assert.equal(yAxisWidth(["0", "5"], width, 12, 32), 32, "a thin axis keeps its floor")
})

test("a five-digit label widens the axis where a two-digit one doesn't", () => {
  const small = yAxisWidth(["0", "5", "10"], width, 12, 32)
  const large = yAxisWidth(["0", "5000", "20000"], width, 12, 32)
  assert.ok(large > small, `the axis grows for the label it carries (${small}px to ${large}px)`)
})

test("the estimate for a label with no canvas errs wide, never narrow", () => {
  // Five digits at an 11px font measure a shade over 30px in the browser; the estimate a test's DOM
  // needs must not come in under that, or a chart would give a label too little room.
  assert.ok(
    estimateWidth("20000", 11) >= 31,
    `a five-digit estimate clears what the font draws (${estimateWidth("20000", 11)}px)`,
  )
  assert.ok(
    estimateWidth("20000", 11) > estimateWidth("20", 11),
    "and a longer label still estimates wider",
  )
})
