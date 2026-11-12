/**
 * A fence as a closer has to match it: the character it is made of, and how many of them. A closer
 * is the same character, no fewer, and nothing else on its line.
 */
export type Fence = { char: string; length: number }

export type Opener = Fence & { rest: string }

/** The fence a line opens, read with the caller's own pattern: the indentation is the policy's. */
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

export function unixLine(line: string) {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

export function unixLength(line: string) {
  return line.endsWith("\r") ? line.length - 1 : line.length
}

export function unixLines(text: string) {
  return text.replace(/\r\n?/g, "\n")
}

const isBlank = (text: string) => /^[ \t]*$/.test(text)
