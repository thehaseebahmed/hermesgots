/**
 * A point, held in a message: the canvas's chat lets the reader tap an element of the page, and the
 * message they send then names it — one marker line per point, carrying the element's label and a
 * selector that finds it again.
 *
 * A user row is its text and nothing else the fold reads, so the markers are the record, as
 * `retry-message.ts` does it: each line is a token pair the fold keys on and a sentence the model reads. The token is the
 * contract, so the words around it may be reworded without turning every message that carried a point
 * back into words the user typed. The pair is exact and the block sits under the words, so the same
 * words typed into the field stay the user's own.
 *
 * Import-free on purpose: the unit tier loads this file under `node --experimental-strip-types`.
 */

/** One element the reader tapped: what it says, and how to find it on the page. */
export interface CanvasPoint {
  label: string
  selector: string
}

/** A marker line begins with the first token and ends with the second; the selector sits after this. */
export const POINT_OPEN = "[POINT — "
export const POINT_SELECTOR = " | selector: "
export const POINT_CLOSE = "]"

/** One point as the model reads it. */
export function pointLine(point: CanvasPoint): string {
  return `${POINT_OPEN}${point.label}${POINT_SELECTOR}${point.selector}${POINT_CLOSE}`
}

/**
 * The point a line names, or null for anything that isn't exactly one. A label may hold the
 * separator's own words, so it is split on the last one: the selector is the field after it.
 */
export function pointIn(line: string): CanvasPoint | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(POINT_OPEN) || !trimmed.endsWith(POINT_CLOSE)) return null
  const body = trimmed.slice(POINT_OPEN.length, -POINT_CLOSE.length)
  const at = body.lastIndexOf(POINT_SELECTOR)
  if (at <= 0) return null
  const label = body.slice(0, at).trim()
  const selector = body.slice(at + POINT_SELECTOR.length).trim()
  return label && selector ? { label, selector } : null
}

/** The message as the model reads it: what the user wrote, then a marker line per point. */
export function pointText(text: string, points: CanvasPoint[] = []): string {
  return [text.trimEnd(), ...points.map(pointLine)].filter(Boolean).join("\n")
}

/**
 * The words a message carried, and the points it named: the marker lines are the trailing block, so
 * anything above the last line that isn't one is the user's own and stays words.
 */
export function pointsIn(content: string): { text: string; points: CanvasPoint[] } {
  // Most messages name no point, and this runs over every row of every fold: the marker is looked
  // for before the text is cut up at all, and then only from its end — a message can be tens of
  // kilobytes, as `retry-message.ts` says of its own.
  if (!content.includes(POINT_OPEN)) return { text: content, points: [] }
  const points: CanvasPoint[] = []
  let end = content.length
  while (end > 0) {
    // From `end - 2`: the newline at `end - 1` is the one that ended the line just read.
    const opensAt = content.lastIndexOf("\n", end - 2) + 1
    const point = pointIn(content.slice(opensAt, end))
    if (!point) break
    points.unshift(point)
    end = opensAt
  }
  if (!points.length) return { text: content, points: [] }
  return { text: content.slice(0, end).trimEnd(), points }
}
