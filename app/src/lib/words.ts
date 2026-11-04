/**
 * Words more than one screen writes, in one place. No imports on purpose: the unit tier runs the
 * modules that read these with no `@/…` alias to resolve, so a string both tiers say lives here.
 */

/** The mark a message that did not go wears, beside its bubble and on the row the device keeps. */
export const NOT_SENT = "Not sent"

export const FAILED = "Failed"

/** A call nobody ran: never a failure (ADR 0098). */
export const REFUSED = "Refused"

/**
 * How much of the message that opened a thread a chat's record keeps: matched to the host's own cut
 * (`_line`'s `MAX_TEXT` in `plugin/triage.py`), so a card reads the same whichever side wrote the
 * opener (ADR 0090, ADR 0096).
 */
export const OPENER_CHARS = 2000

export function oneLine(text: string, max = Number.POSITIVE_INFINITY): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
