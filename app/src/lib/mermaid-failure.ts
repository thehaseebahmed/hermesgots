/**
 * What a failed diagram says under it. mermaid's own first line where mermaid refused the source —
 * a parse error, or a fence it holds no diagram type for — since that is the sentence a reader can
 * act on; the app's own sentence for any other failure drawing it; and, for the one failure that
 * never reached the source at all, the plain word that the chunk did not arrive.
 */

/** The openings mermaid's refusals wear. */
const OWN_WORDS = /^(?:parse error|no diagram type detected)/i

/** A failure drawn as the source it is, with the app's own sentence. */
export const NOT_DRAWN = "Mermaid couldn't draw this diagram."

/** The chunk not arriving: said plainly, and never as the source's fault. */
export const NOT_LOADED = "Mermaid didn't load, so this fence stays as its code."

/** A failure that happened before mermaid read the source: its chunk did not arrive. */
export class NotLoaded extends Error {
  constructor(cause?: unknown) {
    super(NOT_LOADED, { cause })
    this.name = "NotLoaded"
  }
}

/** The one line a failed diagram shows. */
export function failureLine(error: unknown): string {
  if (error instanceof NotLoaded) return NOT_LOADED
  const words = error instanceof Error ? error.message : String(error ?? "")
  const own = words
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  return own && OWN_WORDS.test(own) ? own : NOT_DRAWN
}
