/**
 * A fence as a closer has to match it: the character it is made of, and how many of them. A closer
 * is the same character, no fewer, and nothing else on its line.
 */
export type Fence = { char: string; length: number }

export type Opener = Fence & { rest: string }

/**
 * The fence a line opens where markdown lets a fence stand: up to three spaces of indent, which is
 * what a closer and a fence already open are read with. Every opener is read with it — where an
 * opener may stand is its policy's own rule (`FencePolicy.stands`), not a second pattern.
 */
export const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

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

/** A part of a text drawn as it stands: the stretch itself, at the offset it starts at. */
export type TextPart = { kind: "text"; at: number; text: string }

/** Where a fence line stands in its text: how far in it is, and whether a list item holds it. */
export type Standing = { indent: number; inItem: boolean }

/**
 * A feature's fence, as the one table row `fencedParts` reads a text by: the info string that opens
 * it, where it may stand, what a fence whose closer never came is, and the part it makes. Everything
 * else about the scan — the plain-fence skip, the closer's search, the text on either side, the
 * body's de-indentation — is the text's, and is written once for every feature.
 */
export type FencePolicy<Part extends { at: number }> = {
  /** The info string the opener must say, exactly — and the marker a text must hold to be read. */
  info: string
  /** Whether an opener standing this way is this feature's, or markdown's own code. */
  stands: (standing: Standing) => boolean
  /** What a fence whose closer never came is: the rest of the text, or a part still open. */
  unclosed: "text" | "part"
  /** The part a fence makes, from the body it held and whether its closer came. */
  part: (fence: { at: number; source: string; open: boolean }) => Part
}

const LIST_ITEM = /^( *)([*+-]|[0-9]{1,9}[.)])( +|$)/

// A marker's content starts 1 to 4 spaces after it; five or more leaves one space.
function contentColumn(item: RegExpExecArray) {
  const spaces = item[3].length
  return item[1].length + item[2].length + (spaces > 4 ? 1 : Math.max(spaces, 1))
}

// CommonMark strips up to the opener's indent from every line of the body. A fence at the margin has
// none to strip, which is why one rule serves a diagram and an interface alike.
function deindent(text: string, spaces: number) {
  if (!spaces) return text
  return text.replace(new RegExp(`^ {0,${spaces}}`, "gm"), "")
}

/**
 * Splits a text at the fences one feature draws: the stretches it shows as they are, and the parts
 * the policy makes of a fence whose info string is its own. A fence inside another fence, or one the
 * policy does not claim, is an example of a fence and stays text — and a text holding no marker is
 * answered whole, without a line split, which is what keeps a reply's scan to what it has to cost.
 *
 * A closer may be indented up to three spaces, as markdown allows, and so may a fence already open —
 * so a fence markdown closed that way closes here too, rather than leaving every part after it inside
 * one that never ends.
 */
export function fencedParts<Part extends { at: number }>(
  content: string,
  policy: FencePolicy<Part>,
): (TextPart | Part)[] {
  if (!content.includes(policy.info)) return content ? [{ kind: "text", at: 0, text: content }] : []

  const { lines, starts } = linesOf(content)

  const parts: (TextPart | Part)[] = []
  const items: number[] = []
  const insideItem = (indent: number) => {
    while (items.length && indent < items[items.length - 1]) items.pop()
    return items.length > 0
  }
  let textFrom = 0
  let plain: Fence | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (plain) {
      if (closes(line, plain, FENCE)) plain = null
      continue
    }
    const listItem = LIST_ITEM.exec(line)
    if (listItem) {
      insideItem(listItem[1].length)
      items.push(contentColumn(listItem))
      continue
    }
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const inItem = insideItem(indent)

    const fence = fenceOf(line, FENCE)
    if (!fence) continue
    if (fence.rest !== policy.info || !policy.stands({ indent, inItem })) {
      plain = { char: fence.char, length: fence.length }
      continue
    }

    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (closes(lines[j], fence, FENCE)) {
        close = j
        break
      }
    }
    // Everything below an opener is its body, so a fence whose closer never came ends the scan: the
    // rest of the text is the tail a caller draws as it stands.
    if (close < 0 && policy.unclosed === "text") break

    const open = close < 0
    const bodyStart = i + 1 < lines.length ? starts[i + 1] : content.length
    const body = open ? content.slice(bodyStart) : content.slice(bodyStart, starts[close])
    const source = deindent(unixLines(body), indent).replace(/\n$/, "")

    if (starts[i] > textFrom)
      parts.push({ kind: "text", at: textFrom, text: content.slice(textFrom, starts[i]) })
    parts.push(policy.part({ at: starts[i], source, open }))
    if (open) {
      textFrom = content.length
      break
    }
    textFrom = starts[close] + unixLength(lines[close])
    i = close
  }

  if (textFrom < content.length)
    parts.push({ kind: "text", at: textFrom, text: content.slice(textFrom) })
  return parts
}
