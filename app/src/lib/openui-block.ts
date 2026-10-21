export type OpenuiPart =
  | { kind: "text"; at: number; text: string }
  | { kind: "openui"; at: number; source: string; id?: string; open: boolean }

type Fence = { char: string; length: number }

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^( *)([*+-]|[0-9]{1,9}[.)])( +|$)/
const ID = /^# id: ([a-z0-9-]{1,40})$/
const INFO = "openui-lang"

function fenceOf(line: string) {
  const match = FENCE.exec(line)
  if (!match) return null
  return { char: match[1][0], length: match[1].length, rest: match[2] }
}

function closes(line: string, char: string, length: number) {
  const fence = fenceOf(line)
  return !!fence && fence.char === char && fence.length >= length && /^[ \t]*$/.test(fence.rest)
}

// CommonMark: a list marker is followed by one to four spaces before its item's own content.
function contentColumn(item: RegExpExecArray) {
  return item[1].length + item[2].length + Math.min(item[3].length || 1, 4)
}

function idOf(source: string) {
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return ID.exec(trimmed)?.[1]
  }
  return undefined
}

/**
 * Splits a reply into text and the blocks it asks to be drawn as live Lang: a ```openui-lang fence
 * whose body runs to a closing fence, or to the end of a reply still streaming. A block inside
 * another fence, or indented into a list item, is an example of Lang and stays code.
 */
export function openuiParts(content: string): OpenuiPart[] {
  const lines = content.split("\n")
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }

  const parts: OpenuiPart[] = []
  let textFrom = 0
  let plain: Fence | null = null
  let item: number | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (plain) {
      if (closes(line, plain.char, plain.length)) plain = null
      continue
    }
    const listItem = LIST_ITEM.exec(line)
    if (listItem) {
      item = contentColumn(listItem)
      continue
    }
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (item !== null && indent < item) item = null

    const fence = fenceOf(line)
    if (!fence) continue
    if (fence.rest !== INFO || (item !== null && indent >= item)) {
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
    const source = open
      ? content.slice(bodyStart).replace(/\n$/, "")
      : content.slice(bodyStart, starts[close] - 1)
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
    textFrom = starts[close] + lines[close].length
    i = close
  }

  if (textFrom < content.length)
    parts.push({ kind: "text", at: textFrom, text: content.slice(textFrom) })
  return parts
}
