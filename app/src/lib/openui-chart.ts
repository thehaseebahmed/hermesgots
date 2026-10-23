/**
 * A cartesian chart's y axis, as a rule: which tick values the axis carries for a set of points, and
 * how wide it has to be to draw their labels. A tick label that doesn't fit its axis hangs out of
 * the chart's box, so the width is the labels' own rather than a constant — five digits at a phone's
 * width included.
 */

/** The ticks a y axis carries, counting the bottom one. Recharts' own default. */
const TICK_COUNT = 5

/** The steps a rounded axis may take: two of these, or five, per power of ten. */
const NICE = [1, 2, 5, 10]

export type Axis = {
  /** The values the axis spans, low to high. */
  domain: [number, number]
  /** The values it labels, in order, so exactly these draw. */
  ticks: number[]
}

/** How wide a label draws, in pixels. A browser measures the text; a DOM without a canvas estimates. */
export type Measure = (label: string) => number

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
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
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

/**
 * The width a y axis needs: its widest label, the room between a label and the plot, and a pixel of
 * slack for a font measured before it loaded. `least` keeps an axis of one-digit labels from
 * collapsing into its own ticks.
 */
export function yAxisWidth(labels: string[], measure: Measure, room: number, least: number) {
  const widest = labels.reduce((width, label) => Math.max(width, measure(label)), 0)
  return Math.max(least, Math.ceil(widest + room))
}

/**
 * A label's width where nothing can measure it — a test's DOM has no 2D canvas. It errs wide: a
 * label given a few pixels more than it needs costs plot area, and one given less hangs out of the
 * chart.
 */
export function estimateWidth(label: string, fontSize: number) {
  return label.length * fontSize * 0.62
}
