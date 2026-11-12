/**
 * Mermaid's chunks, as one rule both halves of the build read: the build names a chunk by it, and the
 * gate holds the built worker to the same rule — so there is no negative rule in one place and a
 * positive one in the other to disagree with.
 *
 * A node is mermaid's when mermaid's own code reaches it and the app's own code does not. Mermaid's
 * walk starts at the door — the module `import("mermaid")` names — and the app's starts at the entry
 * and stops at that door, since the app asks for mermaid there rather than carrying it. A chunk is
 * mermaid's when it holds one of those nodes: one module only mermaid reaches is enough, and it is
 * never what the install precaches.
 *
 * Both callers walk the graph they have: the build, its module graph at `buildEnd`; the gate, the
 * built chunks and the imports between them. The path rides with the rule because four places name
 * it — the namer, the worker's ignore, the route that answers it and the gate — and no test would
 * see them drift apart.
 */
export const MERMAID = "assets/mermaid/"

/** A module mermaid's own, wherever the package manager put it. */
export const MERMAID_PACKAGE =
  /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:mermaid|@mermaid-js)\//

export type MermaidGraph = {
  /** Every node: a module of the build's graph, or a chunk of the built one. */
  nodes: readonly string[]
  /** What one node reaches — the same walk over imports, static and on demand alike. */
  reaches: (node: string) => readonly string[]
  /**
   * Whether a node carries mermaid's own code: a module of its packages in the build, and in a built
   * chunk the one word its bundle says so with.
   */
  carries: (node: string) => boolean
  /** The one node `import("mermaid")` names: the door mermaid's chunks hang off. */
  door: string
  /** Where the app starts: the node (or nodes) the index asks for. */
  entry: readonly string[]
}

export type MermaidSplit = {
  /** Mermaid's own: what its code reaches, and what the app's own code does not. */
  mine: Set<string>
  /** Whether a chunk holding these nodes is mermaid's: one of its own in it is enough. */
  names: (held: readonly string[]) => boolean
}

/** Splits a graph into mermaid's nodes and the app's own, and answers the naming rule over them. */
export function mermaidChunks({
  nodes,
  reaches,
  carries,
  door,
  entry,
}: MermaidGraph): MermaidSplit {
  const app = walk(entry, reaches, door)
  const reached = walk([door], reaches)
  const mine = new Set(
    nodes.filter((node) => !app.has(node) && (reached.has(node) || carries(node))),
  )
  return { mine, names: (held) => held.some((node) => mine.has(node)) }
}

function walk(roots: readonly string[], reaches: MermaidGraph["reaches"], stop?: string) {
  const seen = new Set(roots)
  const queue = [...roots]
  while (queue.length) {
    for (const next of reaches(queue.pop() as string)) {
      if (seen.has(next) || next === stop) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}
