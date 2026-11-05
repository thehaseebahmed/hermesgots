// Import-free so the schema walk runs in the unit tier.
type SchemaNode = {
  $ref?: string
  type?: string | string[]
  enum?: unknown[]
  const?: unknown
  anyOf?: SchemaNode[]
  oneOf?: SchemaNode[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  items?: SchemaNode
  description?: string
}

export type ReferenceProp = {
  name: string
  type: string
  required: boolean
}

export type ReferenceEntry = {
  name: string
  description: string
  example: string
  props: ReferenceProp[]
  parents: string[]
  root: boolean
}

export type ReferenceInput = {
  components: readonly string[]
  root: string | undefined
  schema: { $defs?: Record<string, unknown> }
  examples: Readonly<Record<string, string>>
}

const nameOf = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1)

const UNION = 1
const ARRAY = 2
const ATOM = 3

type Rendered = { text: string; precedence: number }

function render(
  node: SchemaNode | undefined,
  defs: Record<string, SchemaNode>,
  names: readonly string[],
  parent = 0,
): Rendered {
  const shaped = shapeOf(node, defs, names)
  return shaped.precedence < parent
    ? { text: `(${shaped.text})`, precedence: shaped.precedence }
    : shaped
}

function shapeOf(
  node: SchemaNode | undefined,
  defs: Record<string, SchemaNode>,
  names: readonly string[],
): Rendered {
  if (!node) return { text: "any", precedence: ATOM }
  if (node.$ref) {
    const name = nameOf(node.$ref)
    // Unregistered defs are zod-generated names (a children union); the members are what a reader wants.
    return names.includes(name)
      ? { text: name, precedence: ATOM }
      : shapeOf(defs[name], defs, names)
  }
  if (node.enum)
    return {
      text: node.enum.map((value) => JSON.stringify(value)).join(" | "),
      precedence: UNION,
    }
  if ("const" in node) return { text: JSON.stringify(node.const), precedence: ATOM }
  const union = node.anyOf ?? node.oneOf
  if (union)
    return {
      text: union.map((part) => render(part, defs, names, UNION).text).join(" | "),
      precedence: UNION,
    }
  if (Array.isArray(node.type)) return { text: node.type.join(" | "), precedence: UNION }
  if (node.type === "array")
    return { text: `${render(node.items, defs, names, ARRAY).text}[]`, precedence: ARRAY }
  if (node.type === "object" || node.properties) {
    const required = node.required ?? []
    const keys = Object.entries(node.properties ?? {}).map(
      ([key, value]) =>
        `${key}${required.includes(key) ? "" : "?"}: ${render(value, defs, names).text}`,
    )
    return { text: `{ ${keys.join(", ")} }`, precedence: ATOM }
  }
  return { text: node.type ?? "any", precedence: ATOM }
}

function componentNamesIn(
  node: SchemaNode,
  defs: Record<string, SchemaNode>,
  names: readonly string[],
): string[] {
  if (node.$ref) {
    const name = nameOf(node.$ref)
    if (names.includes(name)) return [name]
    const inner = defs[name]
    const union = inner?.anyOf ?? inner?.oneOf
    return union ? union.flatMap((member) => componentNamesIn(member, defs, names)) : []
  }
  const union = node.anyOf ?? node.oneOf
  return union ? union.flatMap((member) => componentNamesIn(member, defs, names)) : []
}

function childrenOf(
  def: SchemaNode | undefined,
  defs: Record<string, SchemaNode>,
  names: readonly string[],
): string[] {
  const items = def?.properties?.children?.items
  return items ? componentNamesIn(items, defs, names) : []
}

export function referenceEntries({
  components,
  root,
  schema,
  examples,
}: ReferenceInput): ReferenceEntry[] {
  const defs = (schema.$defs ?? {}) as Record<string, SchemaNode>
  return components.map((name) => {
    const def = defs[name] ?? {}
    const required = def.required ?? []
    return {
      name,
      description: def.description ?? "",
      example: examples[name] ?? "",
      props: Object.entries(def.properties ?? {}).map(([prop, node]) => ({
        name: prop,
        type: render(node, defs, components).text,
        required: required.includes(prop),
      })),
      parents: components.filter(
        (parent) => parent !== name && childrenOf(defs[parent], defs, components).includes(name),
      ),
      root: name === root,
    }
  })
}
