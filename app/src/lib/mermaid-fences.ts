import {
  closes,
  FENCE,
  fenceOf,
  linesOf,
  MARGIN_FENCE,
  unixLength,
  unixLines,
  type Fence,
} from "./fences.ts"

export type MermaidPart =
  | { kind: "text"; at: number; text: string }
  | { kind: "mermaid"; at: number; source: string }

const INFO = "mermaid"

const mayDrawDiagram = (content: string) => content.includes(INFO)

/** A line opening a diagram's fence: `mermaid` and nothing else, standing at the margin. */
function diagramAt(line: string) {
  const fence = fenceOf(line, MARGIN_FENCE)
  return fence && fence.rest === INFO ? fence : null
}

/**
 * Splits a markdown text into the stretches it shows as they are and the closed ```mermaid fences
 * it holds, so a caller can draw each fence's source where the fence stood. Only a fence opening in
 * the first column with an info string of exactly `mermaid`, and closing again, is a diagram: one
 * indented, inside a list item, quoted or inside another fence is an example and stays text, and
 * one whose closer has yet to arrive leaves its tail as text, so a reply still streaming is drawn
 * as the code it is until it finishes.
 *
 * Only the opener is the margin's: a closer may be indented up to three spaces, as markdown allows,
 * and so may a fence that is already open — so a fence markdown closed that way closes here too,
 * rather than leaving every diagram after it inside one that never ends.
 */
export function mermaidParts(content: string): MermaidPart[] {
  if (!mayDrawDiagram(content)) return content ? [{ kind: "text", at: 0, text: content }] : []

  const { lines, starts } = linesOf(content)

  const parts: MermaidPart[] = []
  let textFrom = 0
  let plain: Fence | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (plain) {
      if (closes(line, plain, FENCE)) plain = null
      continue
    }

    const diagram = diagramAt(line)
    const fence = diagram ?? fenceOf(line, FENCE)
    if (!fence) continue
    if (!diagram) {
      plain = { char: fence.char, length: fence.length }
      continue
    }

    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (closes(lines[j], diagram, FENCE)) {
        close = j
        break
      }
    }
    // Everything below an opener is its body, so a fence that never closes ends the scan: the rest
    // of the text is the tail a caller draws as it stands.
    if (close < 0) break

    const bodyStart = i + 1 < lines.length ? starts[i + 1] : content.length
    const source = unixLines(content.slice(bodyStart, starts[close])).replace(/\n$/, "")

    if (starts[i] > textFrom)
      parts.push({ kind: "text", at: textFrom, text: content.slice(textFrom, starts[i]) })
    parts.push({ kind: "mermaid", at: starts[i], source })
    textFrom = starts[close] + unixLength(lines[close])
    i = close
  }

  if (textFrom < content.length)
    parts.push({ kind: "text", at: textFrom, text: content.slice(textFrom) })
  return parts
}
