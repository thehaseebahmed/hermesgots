/**
 * `DESIGN.md` as data: the front matter's tokens and the body cut at its `##` headings, so the
 * style guide draws what the file says rather than a second copy of it. The front matter is a
 * strict subset of YAML (nested maps of scalars, two levels deep, nothing else), read here by
 * indentation so the app takes on no parser for it.
 */

export type Scalar = string
export type TokenMap = Record<string, Scalar>
export type TokenGroups = Record<string, TokenMap>

export type DesignSpec = {
  name: string
  colors: TokenMap
  typography: TokenGroups
  rounded: TokenMap
  spacing: TokenMap
  components: TokenGroups
  /** The body's sections by heading, in file order; the text before the first `##` is `Overview`'s lead. */
  sections: { title: string; body: string }[]
}

const unquote = (value: string) => {
  const text = value.trim()
  const quoted = text.match(/^(["'])(.*)\1$/)
  return quoted ? quoted[2] : text
}

type Node = { [key: string]: string | Node }

/** The front matter's text as nested maps, by the indentation each line carries. */
function readMaps(text: string): Node {
  const root: Node = {}
  const stack: { indent: number; node: Node }[] = [{ indent: -1, node: root }]
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    const colon = line.indexOf(":")
    if (colon < 0) continue
    // A key may be quoted; the value is whatever follows the first colon outside the key.
    const key = unquote(line.slice(0, colon))
    const rest = line.slice(colon + 1).trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].node
    if (rest === "") {
      const child: Node = {}
      parent[key] = child
      stack.push({ indent, node: child })
    } else {
      parent[key] = unquote(rest)
    }
  }
  return root
}

const flat = (node: unknown): TokenMap => {
  const out: TokenMap = {}
  if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node)) if (typeof value === "string") out[key] = value
  return out
}

const grouped = (node: unknown): TokenGroups => {
  const out: TokenGroups = {}
  if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node))
      if (typeof value === "object") out[key] = flat(value)
  return out
}

/** The body cut at each `## ` heading; a heading inside a fence is the fence's own. */
function cutSections(body: string): DesignSpec["sections"] {
  const sections: DesignSpec["sections"] = []
  let title = ""
  let lines: string[] = []
  let fence = false
  const close = () => {
    if (title) sections.push({ title, body: lines.join("\n").trim() })
  }
  for (const line of body.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence
    const heading = !fence && line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      close()
      title = heading[1]
      lines = []
    } else if (title) lines.push(line)
  }
  close()
  return sections
}

export function parseDesign(source: string): DesignSpec {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error("DESIGN.md has no front matter")
  const maps = readMaps(match[1])
  return {
    name: typeof maps.name === "string" ? maps.name : "",
    colors: flat(maps.colors),
    typography: grouped(maps.typography),
    rounded: flat(maps.rounded),
    spacing: flat(maps.spacing),
    components: grouped(maps.components),
    sections: cutSections(match[2]),
  }
}

/** The body of a section by its heading, or an empty string for one the file doesn't have. */
export const sectionOf = (spec: DesignSpec, title: string) =>
  spec.sections.find((section) => section.title === title)?.body ?? ""
