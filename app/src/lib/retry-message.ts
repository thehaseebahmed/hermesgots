/**
 * A retry, read out of a transcript: the app re-asks a failed turn's request, and the message it
 * sends is the model's input rather than a second thing the user said (ADR 0112).
 *
 * The host stores nothing that says so — a retry arrives as an ordinary `user` row — so the markers
 * below are the mark. Each is a token a fold keys on and a sentence the model reads: the token is
 * the contract, the sentence is prose, so the words can be reworded without turning every stored
 * retry back into a message the user sent. Two markers, since a header alone is something a person
 * can type or paste, and their message must stay theirs.
 *
 * Import-free on purpose: the unit tier loads this file under `node --experimental-strip-types`.
 */

/** Line 1 begins with this token; the last line begins with the closing one. */
export const RETRY_OPEN = "[RETRY — "
export const RETRY_CLOSE = "[END OF RETRY — "

const RETRY_OPEN_SAYS =
  "the previous attempt at this request failed before it finished. This is the same request, asked again: carry on from what that attempt already did rather than starting over.]"

const RETRY_CLOSE_SAYS = "the request above is the one asked again.]"

export function retryText(request: string) {
  return `${RETRY_OPEN}${RETRY_OPEN_SAYS}\n${request.trim()}\n${RETRY_CLOSE}${RETRY_CLOSE_SAYS}`
}

/**
 * The request a retry re-asks, or the text itself for anything that is not one — so a caller may ask
 * either way, and which of the two it got is how it knows.
 *
 * Sliced rather than split: a retried paste can be tens of kilobytes, and this runs on every fold.
 * The markers pin the first and last lines, so the request is what lies between them; the closing
 * line's own leading `\r` is the line ending above it, never the request's last character.
 */
export function requestIn(content: string) {
  if (!content.startsWith(RETRY_OPEN)) return content
  const opensAt = content.indexOf("\n")
  if (opensAt < 0) return content
  if (!content.slice(0, opensAt).trimEnd().endsWith("]")) return content
  // The closing marker is the last thing it says, under any blank lines the host added.
  let end = content.length
  while (end > opensAt && /\s/.test(content[end - 1] ?? "")) end--
  const closesAt = content.lastIndexOf("\n", end - 1)
  if (closesAt <= opensAt) return content
  const closing = content.slice(closesAt + 1, end).trim()
  if (!closing.startsWith(RETRY_CLOSE) || !closing.endsWith("]")) return content
  const request = content.slice(opensAt + 1, closesAt)
  if (!request.trim()) return content
  if (!request.includes("\r")) return request
  const body = request.endsWith("\r") ? request.slice(0, -1) : request
  return body.replace(/\r\n/g, "\n")
}

export const isRetryText = (content: unknown): content is string =>
  typeof content === "string" && requestIn(content) !== content

export const isRetryRow = (row: { role?: string | null; content?: string | null }) =>
  row.role === "user" && isRetryText(row.content)
