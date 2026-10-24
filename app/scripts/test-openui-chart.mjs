import assert from "node:assert/strict"
import test from "node:test"

import { LABEL_BAND, LABEL_ROOM, LEAST_AXIS, yAxisOf, yAxisWidth } from "../src/lib/openui-chart.ts"

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
    yAxisWidth(["0", "20000", "500"], width),
    Math.max(LEAST_AXIS, 50 + LABEL_ROOM),
    "5 digits of 10px each, plus the room a label keeps from the plot",
  )
  assert.equal(yAxisWidth(["0", "5"], width), LEAST_AXIS, "a thin axis keeps its floor")
})

test("a rotated y label takes its own column beside the ticks", () => {
  assert.equal(
    yAxisWidth(["0", "20000"], width, { yLabel: true }),
    Math.max(LEAST_AXIS, 50 + LABEL_ROOM) + LABEL_BAND,
    "the ticks' width plus the band the y label names them in",
  )
  assert.equal(
    yAxisWidth(["0", "5"], width, { yLabel: false }),
    yAxisWidth(["0", "5"], width),
    "and no band where there is no y label to draw",
  )
})

test("a five-digit label widens the axis where a two-digit one doesn't", () => {
  const small = yAxisWidth(["0", "5", "10"], width)
  const large = yAxisWidth(["0", "5000", "20000"], width)
  assert.ok(large > small, `the axis grows for the label it carries (${small}px to ${large}px)`)
})
