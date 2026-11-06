/**
 * The rules a component's props cannot state: a chart carries a `summary`, never why it must, and
 * nothing in a schema says a block is fenced or that a page's first line names it.
 *
 * They are written once, here, because two of them are also what the library says on a component's
 * signature line: the prompt build lists the rules and the library glosses its own line, both from
 * this one record, so the words a model is told cannot disagree with the component that draws it.
 *
 * A rule that only means anything to one section carries `in`: the chat's rules are about a fenced
 * block inside a reply, the app's about a whole document per page, and neither section pays for the
 * other's (ADR 0101).
 */
/** Which section a rule belongs to: the chat's, the app's, or both when `in` is absent. */
export type ProseSection = "chat" | "app"

export type ProseRule = {
  /** The component the rule belongs to, or `null` when it is about the block itself. */
  readonly component: string | null
  /** The rule as the prompt lists it. */
  readonly listed?: string
  /** The rule as its component's signature line states it, where that line is where it is said. */
  readonly gloss?: string
  /** The one section this rule belongs to; absent, both sections carry it. */
  readonly in?: ProseSection
}

export const PROSE_RULES: readonly ProseRule[] = [
  {
    component: null,
    listed: "Fence every block with ```openui-lang.",
  },
  {
    component: null,
    listed: "A new interface's first line is a fresh `# id: <slug>`.",
    in: "chat",
  },
  {
    component: null,
    listed: "A page's first line is its `# id: <slug>`, and no two pages share one.",
    in: "app",
  },
  {
    component: null,
    listed: "A change to it is a second block with the same `# id:`.",
    in: "chat",
  },
  {
    component: null,
    listed:
      "A build answers with one block per page, the first the root; a change answers with the " +
      "page's whole replacement.",
    in: "app",
  },
  {
    component: null,
    listed:
      'A page reads the bot with `Query("usage" | "routines" | "projects" | "sessions", {args}, ' +
      '{defaults})`, which draws its defaults until the bot answers; usage takes `{provider}`. A ' +
      'refused read answers `{error}`. `Mutation("tool", {args})` writes.',
    in: "app",
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
  {
    component: "Link",
    gloss: "Moves to the page it names.",
    in: "app",
  },
]

/** The rules one section carries — the one place `in` is read. */
function rulesFor(of: ProseSection): readonly ProseRule[] {
  return PROSE_RULES.filter((rule) => rule.in === undefined || rule.in === of)
}

// `null` selects the block's own rules, a name that component's, `undefined` all of the section's.
function listedFor(of: ProseSection, component: string | null | undefined): string[] {
  return rulesFor(of).flatMap((rule) =>
    rule.listed && (component === undefined || rule.component === component) ? [rule.listed] : [],
  )
}

/** The rules one section lists, in the module's order — the artifact's last lines. */
export function listedRules(of: ProseSection = "chat"): string[] {
  return listedFor(of, undefined)
}

/** The block's own rules in one section; the docs screen shows the chat's. */
export function blockRules(of: ProseSection = "chat"): string[] {
  return listedFor(of, null)
}

export function componentRules(component: string, of: ProseSection = "chat"): string[] {
  return listedFor(of, component)
}

/** The rules one section's signature lines gloss — the components its library may draw. */
export function glossedRules(
  of: ProseSection = "chat",
): readonly { component: string; gloss: string }[] {
  return rulesFor(of).flatMap((rule) =>
    rule.component && rule.gloss ? [{ component: rule.component, gloss: rule.gloss }] : [],
  )
}

/**
 * The rule a component's signature line states, or `undefined` where the module has none for it —
 * which the prompt test catches, since the artifact is generated from these words. No `of` here: a
 * component is defined in exactly one library, and that registration places its line's section.
 */
export function signatureRule(component: string): string | undefined {
  return PROSE_RULES.find((entry) => entry.component === component && entry.gloss)?.gloss
}
