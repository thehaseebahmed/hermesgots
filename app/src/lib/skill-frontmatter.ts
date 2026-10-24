/**
 * A skill's SKILL.md read the way a note is read: its frontmatter as the properties block carries
 * them, its own words as the body. Only the shapes real frontmatter holds — top-level keys, their
 * scalars, their lists, their nested maps and list entries — flattened to plain text, because a
 * properties block is a summary of the note and not a yaml viewer. Import-free so
 * `scripts/test-skill-frontmatter.mjs` can drive it.
 */
export interface SkillProperty {
  key: string
  value: string
}

export interface SkillDocument {
  rows: SkillProperty[]
  body: string
}

const FENCE = /^---[ \t]*\r?$/
const PAIR = /^([^:]+):(.*)$/
const BLOCK = /^([|>])[+-]?\d*$/

/** One key of the frontmatter: its scalar, the keys nested under it, or its list entries. */
type Node = {
  key: string
  scalar: string
  children: Node[]
  items: Node[]
}

export function skillDocument(text: string): SkillDocument {
  const lines = text.split("\n")
  if (lines.length < 2 || !FENCE.test(lines[0] ?? "")) return { rows: [], body: text }
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (close === -1) return { rows: [], body: text }
  return { rows: propertyRows(lines.slice(1, close)), body: lines.slice(close + 1).join("\n") }
}

function propertyRows(lines: string[]): SkillProperty[] {
  const roots: Node[] = []
  // Containers open by indent: a line lands in the last one standing less indented than itself.
  const stack: { indent: number; node: Node }[] = []
  let pending: Node | null = null
  let block: { node: Node; style: "folded" | "literal" } | null = null

  const attach = (node: Node, depth: number) => {
    while ((stack.at(-1)?.indent ?? -1) >= depth) stack.pop()
    stack.at(-1)?.node.children.push(node)
    stack.push({ indent: depth, node })
    pending = node
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const indent = line.length - line.trimStart().length
    // A block scalar owns every deeper line until the next key at its own level or above.
    if (block) {
      if (indent > 0) {
        const glue = block.style === "folded" ? " " : "\n"
        block.node.scalar = block.node.scalar ? `${block.node.scalar}${glue}${trimmed}` : trimmed
        continue
      }
      block = null
    }

    const item = indent > 0 ? /^-(?: (.*))?$/.exec(trimmed) : null
    if (item) {
      const rest = (item[1] ?? "").trim()
      const node: Node = { key: "", scalar: "", children: [], items: [] }
      const nested = PAIR.exec(rest)
      if (nested && nested[1].trim()) {
        node.children.push({
          key: nested[1].trim(),
          scalar: scalar(nested[2]),
          children: [],
          items: [],
        })
      } else {
        node.scalar = scalar(rest)
      }
      while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop()
      stack.at(-1)?.node.items.push(node)
      stack.push({ indent, node })
      pending = node
      continue
    }

    const pair = PAIR.exec(trimmed)
    if (pair && pair[1].trim()) {
      const key = pair[1].trim()
      const value = scalar(pair[2])
      const folded = BLOCK.test(value)
      const node: Node = { key, scalar: folded ? "" : value, children: [], items: [] }
      // A key written twice would draw two rows under one key; the first wins, which is the
      // order the note reads in. The later key's own subtree sinks into a node nothing renders.
      const first = indent > 0 || !roots.some((root) => root.key === key)
      if (indent === 0) {
        node.key = first ? key : ""
        if (first) roots.push(node)
      }
      attach(node, indent)
      if (folded) block = { node, style: value.startsWith("|") ? "literal" : "folded" }
      continue
    }

    // A scalar continued onto the next lines, under the key or list entry that opened it.
    if (pending) pending.scalar = pending.scalar ? `${pending.scalar} ${trimmed}` : trimmed
  }

  return roots.map((root) => ({ key: root.key, value: flatten(root) })).filter((row) => row.key)
}

function flatten(node: Node): string {
  const parts = [
    ...(node.scalar ? [node.scalar] : []),
    ...node.children.map((child) => `${child.key}: ${flatten(child)}`),
    ...node.items.map((item) => flatten(item)),
  ]
  return parts.filter(Boolean).join(", ")
}

function scalar(value: string): string {
  const trimmed = value.trim()
  const list = /^\[(.*)\]$/.exec(trimmed)
  if (list) {
    return list[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .join(", ")
  }
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return (quoted ? quoted[2] : trimmed).trim()
}
