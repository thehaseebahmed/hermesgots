import { mergeStatements, parseExpression, split, tokenize } from "@openuidev/lang-core"

import type { Message } from "@/lib/db"

import { mayCarryBlock, openuiParts, type OpenuiPart } from "./openui-block.ts"

export type ThreadRow = Pick<Message, "id" | "role" | "content">

export type InterfaceDraw =
  | { kind: "interface"; source: string; id?: string }
  | { kind: "patch"; id: string }
  | { kind: "orphan"; id?: string }

/** One block of a row, and what it draws. `at` is where the block starts in the row's text. */
export type ThreadBlock = { at: number; draw: InterfaceDraw }

const ROOT = "root"

type OpenBlock = Extract<OpenuiPart, { kind: "openui" }>
type Claimed = Extract<InterfaceDraw, { kind: "interface" }> & { id: string }

/** A source with its comments gone, the way the library's parser reads one; its merge does not. */
function uncommented(source: string) {
  let quote = ""
  return source
    .split("\n")
    .map((line) => {
      for (let at = 0; at < line.length; at++) {
        const char = line[at]
        if (quote) {
          if (char === "\\") at++
          else if (char === quote) quote = ""
          continue
        }
        if (char === '"' || char === "'") quote = char
        else if (char === "#" || (char === "/" && line[at + 1] === "/"))
          return line.slice(0, at).trimEnd()
      }
      return line
    })
    .join("\n")
}

function enters(source: string, root: string | undefined) {
  return split(tokenize(source)).some((stmt) => {
    if (stmt.id === ROOT) return true
    if (root === undefined) return false
    const expr = parseExpression(stmt.tokens)
    return expr.k === "Comp" && !expr.fn && expr.name === root
  })
}

function drawOf(
  part: OpenBlock,
  claimed: Map<string, Claimed>,
  root: string | undefined,
): InterfaceDraw {
  const { id } = part
  const source = uncommented(part.source)
  const carried = id === undefined ? undefined : claimed.get(id)
  if (id !== undefined && carried) {
    // The library roots a program at `mergeStatements`' third argument: a statement id, not an
    // interface's.
    if (!part.open && split(tokenize(source)).length)
      carried.source = mergeStatements(uncommented(carried.source), source)
    return { kind: "patch", id }
  }
  if (!part.open && !enters(source, root))
    return id === undefined ? { kind: "orphan" } : { kind: "orphan", id }
  if (id === undefined) return { kind: "interface", source: part.source }
  const draw: Claimed = { kind: "interface", source: part.source, id }
  claimed.set(id, draw)
  return draw
}

/**
 * Every block each row of the thread carries, keyed by the row's id, in thread order. Each interface's
 * `source` is its final resolved source, with every patch that names its id already merged in. `root`
 * is the library's root component name, which lets a block whose entry is named anything but `root`
 * stand; a caller without a library gets the statement named `root` alone.
 */
export function resolveInterfaces(rows: ThreadRow[], root?: string): Map<string, ThreadBlock[]> {
  const claimed = new Map<string, Claimed>()
  const drawn = new Map<string, ThreadBlock[]>()
  for (const row of rows) {
    if (row.role !== "assistant" || !mayCarryBlock(row.content)) continue
    const blocks: ThreadBlock[] = []
    for (const part of openuiParts(row.content)) {
      if (part.kind === "openui") blocks.push({ at: part.at, draw: drawOf(part, claimed, root) })
    }
    if (blocks.length) drawn.set(row.id, blocks)
  }
  return drawn
}
