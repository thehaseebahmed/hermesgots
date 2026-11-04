/**
 * The one line a tool row says about the calls it holds: their phrases joined into a sentence, and —
 * when they don't all fit the row — as many as do, with `(+N)` standing in for the rest (ADR 0050).
 * The count is the row's, never the sheet's: a reader sees at a glance that there is more, and the
 * sheet is where the calls themselves are read.
 */

const sentence = (parts: string[]) =>
  parts.map((part, index) => (index ? part[0].toLowerCase() + part.slice(1) : part)).join(", ")

/** The first `shown` phrases, and how many more there are when it is cut short. */
export function summary(parts: string[], shown = parts.length) {
  return (
    sentence(parts.slice(0, shown)) + (shown < parts.length ? ` (+${parts.length - shown})` : "")
  )
}

/**
 * How many phrases fit a row `room` wide, asked of `width` — which measures one candidate string the
 * way the row would draw it. Never zero: a row always says one phrase, so a very narrow row reads
 * "Ran a command (+9)" rather than a bare count. A room of nothing is a row the browser has not laid
 * out yet, which answers `undefined` rather than a guess: settling on it is what leaves every phrase
 * to be cut by CSS, and a cut line carries no count at all.
 */
export function fittingPhrases(
  parts: string[],
  room: number,
  width: (text: string) => number,
): number | undefined {
  if (!room || !parts.length) return undefined
  let fits = 1
  let tooMany = parts.length
  while (fits < tooMany) {
    const count = Math.ceil((fits + tooMany) / 2)
    const measured = width(summary(parts, count))
    if (!measured) return undefined
    if (measured <= room) fits = count
    else tooMany = count - 1
  }
  return fits
}
