const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CLOSE = /^ {0,3}(`+|~+)\s*$/
const LIST_ITEM = /^([*+-]|\d{1,9}[.)])(\s|$)/
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m

/**
 * Splits markdown into top-level blocks that render the same on their own: at a blank line outside
 * a code fence, before a line that can't continue what came before it (not indented, not a list
 * item). Text with link or footnote definitions stays whole, since those reach across blocks.
 */
export function markdownBlocks(text: string) {
  if (DEFINITION.test(text)) return [text]
  const blocks: string[] = []
  let start = 0
  let fence: string | undefined
  let blank = false
  let at = 0
  for (const line of text.split("\n")) {
    const mark = FENCE.exec(line)?.[1]
    if (fence) {
      // A fence closes on a bare run of its own character, at least as long as the one that opened it.
      if (mark?.[0] === fence[0] && mark.length >= fence.length && CLOSE.test(line))
        fence = undefined
    } else if (!line.trim()) {
      blank = true
    } else {
      if (blank && at > start && !/^\s/.test(line) && !LIST_ITEM.test(line)) {
        blocks.push(text.slice(start, at))
        start = at
      }
      blank = false
      if (mark) fence = mark
    }
    at += line.length + 1
  }
  blocks.push(text.slice(start))
  return blocks
}
