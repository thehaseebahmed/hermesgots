import { fencedParts, type FencePolicy, type TextPart } from "./fences.ts"

type Diagram = { kind: "mermaid"; at: number; source: string }

export type MermaidPart = TextPart | Diagram

/**
 * A reply cut at its diagrams: the stretches it shows as they are and the closed ```mermaid fences it
 * holds, so a caller can draw each fence's source where the fence stood. Only a fence opening in the
 * first column with an info string of exactly `mermaid`, and closing again, is a diagram: one
 * indented, inside a list item, quoted or inside another fence is an example and stays text, and one
 * whose closer has yet to arrive leaves its tail as text, so a reply still streaming is drawn as the
 * code it is until it finishes.
 */
const DIAGRAM: FencePolicy<Diagram> = {
  info: "mermaid",
  stands: ({ indent }) => indent === 0,
  unclosed: "text",
  part: ({ at, source }) => ({ kind: "mermaid", at, source }),
}

export function mermaidParts(content: string): MermaidPart[] {
  return fencedParts(content, DIAGRAM)
}
