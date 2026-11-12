// `at` indexes into the string given to `mermaidParts`, and the parts tile that string in order,
// with no gaps or overlaps.
import { closes, fenceOf, linesOf, unixLength, unixLines, type Fence } from "./fences.ts"

export type MermaidPart =
  | { kind: "text"; at: number; text: string }
  | { kind: "mermaid"; at: number; source: string }

// No leading spaces are allowed here, unlike the block splitter's fence: a fence set into a line is
// that line's content — a list item's example, a quote's — and markdown draws it as code, so only
// the fence standing at the margin is the text's own.
const FENCE = /^(`{3,}|~{3,})(.*)$/
const INFO = "mermaid"

/**
 * Whether a text could hold a diagram at all. The marker is the word a fence opens with, so a text
 * without it — most of what a reply says — is answered as one part without a line being split.
 */
const mayDrawDiagram = (content: string) => content.includes(INFO)

/**
 * Splits a markdown text into the stretches it shows as they are and the closed ```mermaid fences
 * it holds, so a caller can draw each fence's source where the fence stood. Only a fence opening in
 * the first column with an info string of exactly `mermaid`, and closing again, is a diagram: one
 * indented, inside a list item, quoted or inside another fence is an example and stays text, and
 * one whose closer has yet to arrive leaves its tail as text, so a reply still streaming is drawn
 * as the code it is until it finishes.
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

    const fence = fenceOf(line, FENCE)
    if (!fence) continue
    if (fence.rest !== INFO) {
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
