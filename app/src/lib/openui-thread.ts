/**
 * The fold that answers what each `openui-lang` block in a thread draws.
 *
 * A block naming an id an earlier interface already carries is a patch: its source is merged into
 * that interface's resolved source, in thread order, and the block draws nothing of its own. Any other
 * finished block opens an interface. The exception is a finished block that draws nothing of its own
 * and patches nothing, which the thread reports as an orphan: it holds no entry, and if it names an
 * id, no interface before it does. A block still streaming is read as what the reply is writing, so it
 * opens an interface unless it patches one, and the renderer's parser decides what of it can draw.
 *
 * An entry is the library's own question (`pickEntry`, `@openuidev/lang-core@1.0.1`,
 * `dist/index.mjs:3543`): the statement named `root`, else the first statement calling the root
 * component, whose name only a caller holding the library can give. Merging is its `mergeStatements`
 * (`:4069`) too, so this fold and the renderer agree about what a patch did. Comments go before both,
 * since the merge reads them as statements where its parser does not (`stripComments`, `:3707`). A
 * merged source comes back without the block's `# id:` line and without the statements its entry can
 * no longer reach, both of which its rebuild drops; an interface no patch has touched keeps its text
 * whole.
 */
import { mergeStatements, parseExpression, split, tokenize } from "@openuidev/lang-core"

import type { Message } from "@/lib/db"

import { carriesBlock, openuiParts, type OpenuiPart } from "./openui-block.ts"

/** A thread row as the fold reads it. */
export type ThreadRow = Pick<Message, "id" | "role" | "content">

/** What one `openui-lang` block in a thread draws. */
export type InterfaceDraw =
  | { kind: "interface"; source: string; id?: string }
  | { kind: "patch"; id: string }
  | { kind: "orphan"; id?: string }

/** One block of a row, and what it draws. `at` is where the block starts in the row's text. */
export type ThreadBlock = { at: number; draw: InterfaceDraw }

// The statement every program roots at, `DEFAULT_ROOT_STATEMENT_ID` in the library.
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
    // `mergeStatements`' third argument is the statement a program roots at, not an interface's id, and
    // the library skips its garbage collection when no statement carries one. A patch holding no
    // statement is left out, since merging one only rebuilds the interface to say nothing.
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
 * is the library's root component, which widens what counts as an entry the way the library does; a
 * caller without a library gets the statement named `root` alone.
 */
export function resolveInterfaces(rows: ThreadRow[], root?: string): Map<string, ThreadBlock[]> {
  const claimed = new Map<string, Claimed>()
  const drawn = new Map<string, ThreadBlock[]>()
  for (const row of rows) {
    if (row.role !== "assistant" || !carriesBlock(row.content)) continue
    const blocks: ThreadBlock[] = []
    for (const part of openuiParts(row.content)) {
      if (part.kind === "openui") blocks.push({ at: part.at, draw: drawOf(part, claimed, root) })
    }
    if (blocks.length) drawn.set(row.id, blocks)
  }
  return drawn
}
