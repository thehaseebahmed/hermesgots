/**
 * The rules a component's props cannot state: a chart carries a `summary`, never why it must, and
 * nothing in a schema says a block is fenced or that a page's first line names it.
 *
 * They are written once, here, because two of them are also what the library says on a component's
 * signature line: the prompt build lists the rules and the library glosses its own line, both from
 * this one record, so the words a model is told cannot disagree with the component that draws it.
 */

export type ProseRule = {
  /** The component the rule belongs to, or `null` when it is about the block itself. */
  readonly component: string | null
  /** The rule as the prompt lists it. */
  readonly listed?: string
  /** The rule as its component's signature line states it, where that line is where it is said. */
  readonly gloss?: string
}

export const PROSE_RULES: readonly ProseRule[] = [
  {
    component: null,
    listed: "Fence every block with ```openui-lang.",
  },
  {
    component: null,
    listed: "A new interface's first line is a fresh `# id: <slug>`.",
  },
  {
    component: null,
    listed: "A change to it is a second block with the same `# id:`.",
  },
  {
    component: "Table",
    listed: "A table's cells are plain text: no markdown, no links.",
    gloss: "Plain-text cells.",
  },
  {
    component: "Chart",
    gloss: "A bar, line, area or pie chart; summary in words.",
  },
  {
    component: "Map",
    gloss: "Labeled places on a map at coordinates you supply, never looked up; summary in words.",
  },
]

// `null` selects the block's own rules, a name that component's, `undefined` all of them.
function listedFor(component: string | null | undefined): string[] {
  return PROSE_RULES.flatMap((rule) =>
    rule.listed && (component === undefined || rule.component === component) ? [rule.listed] : [],
  )
}

/** The rules the prompt lists, in the module's order — the artifact's last lines. */
export function listedRules(): string[] {
  return listedFor(undefined)
}

/** The block's own rules; the docs screen shows them. */
export function blockRules(): string[] {
  return listedFor(null)
}

export function componentRules(component: string): string[] {
  return listedFor(component)
}

/** The rules the signature lines gloss — the components the library may draw. */
export function glossedRules(): readonly { component: string; gloss: string }[] {
  return PROSE_RULES.flatMap((rule) =>
    rule.component && rule.gloss ? [{ component: rule.component, gloss: rule.gloss }] : [],
  )
}

/**
 * The rule a component's signature line states, or `undefined` where the module has none for it —
 * which the prompt test catches, since the artifact is generated from these words.
 */
export function signatureRule(component: string): string | undefined {
  return PROSE_RULES.find((entry) => entry.component === component && entry.gloss)?.gloss
}
