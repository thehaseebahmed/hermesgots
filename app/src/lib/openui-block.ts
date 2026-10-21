export type OpenuiPart =
  | { kind: "text"; at: number; text: string }
  | { kind: "openui"; at: number; source: string; id?: string; open: boolean }

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^( *)([*+-]|[0-9]{1,9}[.)])( +|$)/
const ID = /^# id: ([a-z0-9-]{1,40})$/
const INFO = "openui-lang"

/** A bare run of the opener's character, at least as long, up to three spaces in. */
function closes(line: string, char: string, length: number) {
  const body = line.replace(/^ {0,3}/, "")
  let run = 0
  while (body[run] === char) run++
  return run >= length && /^[ \t]*$/.test(body.slice(run))
}

/** The block's id sits on the first line of the body with anything on it. */
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
  let plain: { char: string; length: number } | null = null
  // The innermost open list item's content column: a fence that far in belongs to the item. A
  // nested item is already measured from the margin, so it just becomes the current one.
  let item: number | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (plain) {
      if (closes(line, plain.char, plain.length)) plain = null
      continue
    }
    const listItem = LIST_ITEM.exec(line)
    if (listItem) {
      item = listItem[1].length + listItem[2].length + Math.min(listItem[3].length || 1, 4)
      continue
    }
    if (!line.trim()) continue
    if (item !== null && line.length - line.trimStart().length < item) item = null

    const fence = FENCE.exec(line)
    if (!fence) continue
    const char = fence[2][0]
    const length = fence[2].length
    if (fence[3] !== INFO || (item !== null && fence[1].length >= item)) {
      plain = { char, length }
      continue
    }

    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (closes(lines[j], char, length)) {
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
