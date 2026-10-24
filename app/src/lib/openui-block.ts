// `at` indexes into the string given to `openuiParts`, and the parts tile that string in order,
// with no gaps or overlaps.
export type OpenuiPart =
  | { kind: "text"; at: number; text: string }
  | { kind: "openui"; at: number; source: string; id?: string; open: boolean }

type Fence = { char: string; length: number }

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^( *)([*+-]|[0-9]{1,9}[.)])( +|$)/
const ID = /^# id: ([a-z0-9-]{1,40})$/
export const INFO = "openui-lang"

/**
 * The inset a reply's text carries, and the one its interface takes beside it: with both, a block
 * starting to draw moves nothing and its edges land on the text's.
 */
export const REPLY_INSET = "px-1"

function fenceOf(line: string) {
  const match = FENCE.exec(line.replace(/\r$/, ""))
  if (!match) return null
  return { char: match[1][0], length: match[1].length, rest: match[2] }
}

function closes(line: string, char: string, length: number) {
  const fence = fenceOf(line)
  return !!fence && fence.char === char && fence.length >= length && /^[ \t]*$/.test(fence.rest)
}

function unixLines(text: string) {
  return text.replace(/\r\n?/g, "\n")
}

// A marker's content starts 1 to 4 spaces after it; five or more leaves one space.
function contentColumn(item: RegExpExecArray) {
  const spaces = item[3].length
  return item[1].length + item[2].length + (spaces > 4 ? 1 : Math.max(spaces, 1))
}

// CommonMark strips up to the opener's indent from every line of the body.
function deindent(text: string, spaces: number) {
  if (!spaces) return text
  return text.replace(new RegExp(`^ {0,${spaces}}`, "gm"), "")
}

function idOf(source: string) {
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return ID.exec(trimmed)?.[1]
  }
  return undefined
}

export function mayCarryBlock(content: string): boolean {
  return content.includes(INFO)
}

/**
 * Splits a reply into text and the blocks it asks to be drawn as live Lang: a ```openui-lang fence
 * whose body runs to a closing fence, or to the end of a reply still streaming. The info string is
 * compared exactly, so a space before or after `openui-lang` leaves the fence as text. A block
 * inside another fence, or indented into a list item, is an example of Lang and stays code.
 */
export function openuiParts(content: string): OpenuiPart[] {
  if (!mayCarryBlock(content)) return content ? [{ kind: "text", at: 0, text: content }] : []

  const lines = content.split("\n")
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }

  const parts: OpenuiPart[] = []
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
      if (closes(line, plain.char, plain.length)) plain = null
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

    const fence = fenceOf(line)
    if (!fence) continue
    if (fence.rest !== INFO || inItem) {
      plain = { char: fence.char, length: fence.length }
      continue
    }

    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (closes(lines[j], fence.char, fence.length)) {
        close = j
        break
      }
    }
    const open = close < 0
    const bodyStart = i + 1 < lines.length ? starts[i + 1] : content.length
    const body = open ? content.slice(bodyStart) : content.slice(bodyStart, starts[close])
    const source = deindent(unixLines(body), indent).replace(/\n$/, "")
    const id = idOf(source)

    if (starts[i] > textFrom)
      parts.push({ kind: "text", at: textFrom, text: content.slice(textFrom, starts[i]) })
    const part: OpenuiPart = { kind: "openui", at: starts[i], source, open }
    if (id) part.id = id
    parts.push(part)
    if (open) {
      textFrom = content.length
      break
    }
    textFrom = starts[close] + lines[close].replace(/\r$/, "").length
    i = close
  }

  if (textFrom < content.length)
    parts.push({ kind: "text", at: textFrom, text: content.slice(textFrom) })
  return parts
}
