/**
 * What two fence rules read off a text, shared: the fence a line opens, whether a line closes one, a
 * text's lines with the offset each starts at, and the CR a CRLF text leaves at their ends.
 *
 * What is not shared is the policy, because it is what the two features disagree about. `openui-lang`
 * opens with up to three spaces in front of it, keeps track of the list items it is inside, and an
 * opener whose closer has yet to arrive is still a block — the block is what the reply is about.
 * `mermaid` opens in the first column only, and an opener that never closes leaves its tail as the
 * text it is, so a reply still streaming draws no half diagram. A scanner given both rules as a
 * policy object would say neither of them plainly, so each rule keeps its own loop over these.
 *
 * Import-free, since `scripts/test-mermaid-fences.mjs` runs one of the rules as a pure function and
 * both are reached from a route that is on the startup path.
 */

/**
 * A fence as a closer has to match it: the character it is made of, and how many of them. A closer
 * is the same character, no fewer, and nothing else on its line.
 */
export type Fence = { char: string; length: number }

/** A fence as a line writes it: the two above, and whatever follows them on the line. */
export type Opener = Fence & { rest: string }

/**
 * The fence a line opens, read with the caller's own pattern — a fence's own indentation is the
 * policy's, so the pattern that says what may stand in front of it belongs to the caller.
 */
export function fenceOf(line: string, pattern: RegExp): Opener | null {
  const match = pattern.exec(unixLine(line))
  if (!match) return null
  return { char: match[1][0], length: match[1].length, rest: match[2] }
}

/** Whether a line closes the fence opened as `fence`: the same character, no shorter, nothing after. */
export function closes(line: string, fence: Fence, pattern: RegExp) {
  const opener = fenceOf(line, pattern)
  return (
    !!opener && opener.char === fence.char && opener.length >= fence.length && isBlank(opener.rest)
  )
}

/**
 * A text's lines, and the offset each starts at. The offsets tile the string, so a part of a text is
 * a slice of it and a fence's body runs from the line after its opener to the line its closer stands
 * on. The line endings are kept: only the offsets can say where a part begins.
 */
export function linesOf(content: string) {
  const lines = content.split("\n")
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  return { lines, starts }
}

/** A line without the CR a CRLF text leaves at its end: a slice, so no pattern runs per line. */
export function unixLine(line: string) {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

/** That line's length, counted without building the slice — what a closer's offset is added to. */
export function unixLength(line: string) {
  return line.endsWith("\r") ? line.length - 1 : line.length
}

/** A text with one kind of line ending, for a body read as source rather than as offsets. */
export function unixLines(text: string) {
  return text.replace(/\r\n?/g, "\n")
}

const isBlank = (text: string) => /^[ \t]*$/.test(text)
