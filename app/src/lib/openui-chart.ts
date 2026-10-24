/**
 * A cartesian chart's y axis, as a rule: which tick values the axis carries for a set of points, and
 * how wide it has to be to draw their labels. A tick label that doesn't fit its axis hangs out of
 * the chart's box, so the width is the labels' own rather than a constant — five digits at a phone's
 * width included.
 */

/** The ticks a y axis carries, counting the bottom one. Recharts' own default. */
const TICK_COUNT = 5

const NICE = [1, 2, 5, 10]

export type Axis = {
  /** The values the axis spans, low to high. */
  domain: [number, number]
  /** The values it labels, in order, so exactly these draw. */
  ticks: number[]
}

/** How wide a label draws, in pixels. The surface measures the text on a canvas. */
export type Measure = (label: string) => number

export const TICK_STUB = 6
export const TICK_MARGIN = 4

/** The room a label keeps from the plot: stub, margin, and two pixels for a late-loading font. */
export const LABEL_ROOM = TICK_STUB + TICK_MARGIN + 2

export const LEAST_AXIS = 32

export const LABEL_BAND = 12

function stepFor(span: number, count: number) {
  const raw = span / (count - 1)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const scaled = raw / magnitude
  return (NICE.find((step) => scaled <= step) ?? 10) * magnitude
}

/**
 * The axis a chart's points need. Zero is always in the range: a bar is drawn from the axis' foot,
 * and recharts' own default domain starts there too. A point below zero pulls the foot down with it.
 */
export function yAxisOf(values: number[]): Axis {
  if (!values.length) return { domain: [0, 1], ticks: [0, 1] }
  let min = 0
  let max = 0
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  if (min === max) return { domain: [0, 1], ticks: [0, 1] }

  const step = stepFor(max - min, TICK_COUNT)
  const low = Math.floor(min / step) * step
  const high = Math.ceil(max / step) * step
  // A step under 1 lands on fractions, where `low + i * step` leaves the dust a float sum always
  // leaves; the labels are drawn from these numbers, so they are rounded to the step's own place.
  const places = Math.max(0, -Math.floor(Math.log10(step)))
  const count = Math.round((high - low) / step) + 1
  const ticks = Array.from({ length: count }, (_, i) => Number((low + i * step).toFixed(places)))
  return { domain: [low, high], ticks }
}

/** The width a y axis needs: its widest label and the room between it and the plot. */
export function yAxisWidth(
  labels: string[],
  measure: Measure,
  opts?: { yLabel?: boolean },
): number {
  const widest = labels.reduce((width, label) => Math.max(width, measure(label)), 0)
  return Math.max(LEAST_AXIS, Math.ceil(widest + LABEL_ROOM)) + (opts?.yLabel ? LABEL_BAND : 0)
}
