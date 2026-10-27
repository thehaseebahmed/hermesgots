/**
 * The rules a status line types by (ADR 0061): the words a label arrives as, the one step a line
 * takes toward a new label, and the dots it grows once its words are in. Import-free, so
 * `scripts/test-typing.mjs` runs them as rules without a screen, and the clock that drives them is
 * `src/components/chat/typed-line.tsx`.
 */

/** How long one character takes to arrive, and one to be rubbed out. */
export const TYPE_MS = 26
export const ERASE_MS = 12

/** How long the line holds a step of its dots, and how many steps it cycles through. */
export const DOTS_MS = 500
export const DOTS_STEPS = 4

const ELLIPSIS = "…"

/**
 * The words a label types: its own text without the ellipsis it ends on, which the line grows as
 * dots rather than typing. A label carrying none is typed as it is.
 */
export function typedLabel(label: string) {
  return label.endsWith(ELLIPSIS) ? label.slice(0, -ELLIPSIS.length).trimEnd() : label
}

/**
 * The next text a line shows on its way to `label`: backspace to the last character the two share,
 * then type the rest a character at a time. Keeping the shared start is what makes a turn's change
 * read as the turn moving on rather than starting over. A line already at its label stays there.
 */
export function nextText(shown: string, label: string) {
  const target = typedLabel(label)
  if (target.startsWith(shown)) return target.slice(0, shown.length + 1)
  return shown.slice(0, -1)
}

/**
 * The dots a line shows at a step of its cycle: none, one, two, three, then none again — so a turn
 * that sits on one label keeps moving without its words being typed over and over.
 */
export function dotsAt(step: number) {
  return ".".repeat(step % DOTS_STEPS)
}

/**
 * What a line reads at a moment: what has arrived, and once its words are all in, the dots a step of
 * its cycle adds. The ellipsis a label ends on is never part of `shown`, so it is only ever the dots.
 */
export function lineText(shown: string, label: string, step: number) {
  return shown === typedLabel(label) ? shown + dotsAt(step) : shown
}

/**
 * The widest a line can read, which is the text its box has to hold for nothing beside it to move: a
 * label ending on an ellipsis reads its words and up to three dots, and any other label reads whole.
 * The dots are wider than the ellipsis glyph, so holding them holds the label drawn whole too.
 */
export function heldLabel(label: string) {
  const words = typedLabel(label)
  return words === label ? label : words + dotsAt(DOTS_STEPS - 1)
}
