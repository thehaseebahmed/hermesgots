/**
 * The fold that answers what each `openui-lang` block in a thread draws.
 *
 * A block naming an id an earlier interface already carries is a patch: its source is merged into
 * that interface's resolved source, in thread order, and the block draws nothing of its own. Any other
 * finished block opens an interface. The exception is a finished block that holds no entry: it is a
 * patch with nothing to patch, so the thread reports it as an orphan rather than merging it into
 * nothing. A block still streaming is read as what the reply is writing, so it opens an interface,
 * and the renderer's parser decides what of it can draw.
 *
 * An entry is the library's own question (`pickEntry`, `@openuidev/lang-core@1.0.1`,
 * `dist/index.mjs:3543`): the statement named `root`, else the first statement calling the root
 * component, whose name only a caller holding the library can give. Merging is its `mergeStatements`
 * (`:4069`) too, so this fold and the renderer can never disagree about what a patch did. A merged
 * source comes back without the block's `# id:` line, since a merge rebuilds a program from its
 * statements; an interface no patch has touched keeps the line, and both parse the same.
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

function enters(source: string, root: string | undefined) {
  return split(tokenize(source)).some((stmt) => {
    if (stmt.id === ROOT) return true
    if (root === undefined) return false
    const expr = parseExpression(stmt.tokens)
    return expr.k === "Comp" && expr.name === root
  })
}

function drawOf(
  part: OpenBlock,
  claimed: Map<string, Claimed>,
  root: string | undefined,
): InterfaceDraw {
  const { id } = part
  const carried = id === undefined ? undefined : claimed.get(id)
  if (id !== undefined && carried) {
    // No third argument to `mergeStatements`. Its `rootId` is the statement a program roots at, not an
    // interface's id, and the library skips its garbage collection when no statement carries one.
    if (!part.open) carried.source = mergeStatements(carried.source, part.source)
    return { kind: "patch", id }
  }
  if (!part.open && !enters(part.source, root))
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
