import type { McpCatalogueEntry, McpCatalogueValue } from "@/lib/hermes"

/**
 * The Catalogue entries a search keeps: a match anywhere in an entry's name, or in Hermes's own
 * description of it, case-insensitively, and an empty search keeps every entry. Kept import-free so
 * `scripts/test-mcp-catalogue.mjs` can drive it, and so the screen only decides how to draw the
 * answer: an empty list from a search that was typed is the Catalogue saying nothing matches.
 */
export function searchCatalogue(entries: McpCatalogueEntry[], query: string): McpCatalogueEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle),
  )
}

/**
 * What a field holds: what was typed into it, or — when nothing was — the default it is showing. A
 * field the user emptied is empty rather than its default again, so clearing one is a choice that
 * sticks.
 */
export function fieldValue(value: McpCatalogueValue, entered: Record<string, string>): string {
  return (entered[value.name] ?? value.default) || ""
}

/**
 * The values an entry declares that an add can't go ahead without: the ones marked required that hold
 * nothing and that this Bot doesn't already hold. A value already set on the Host is never missing
 * (its content is the Host's and never reaches the screen), a space or two is nothing typed in, and a
 * value the entry leaves optional may stay empty. The form marks these fields and refuses the add on
 * the same rule, and the Host refuses the add too (`plugin/mcp.py`), though its own backstop is the
 * weaker one — a value of nothing at all — so the app is the stricter of the two.
 */
export function missingValues(
  values: McpCatalogueValue[],
  entered: Record<string, string>,
): string[] {
  return values
    .filter((value) => value.required && !value.set && !fieldValue(value, entered).trim())
    .map((value) => value.name)
}

/**
 * The values an add sends, by the name each declares: every field's own content, and nothing for a
 * value this Bot already holds — the Host reports only that it has one, and re-sending what it never
 * gave the app is impossible. A field left untouched sends the default it was showing, so a default a
 * manifest pins lands in the configuration rather than being left as the manifest's own `${NAME}`
 * reference; an empty field sends nothing at all, which is how the Host reads "nothing given".
 */
export function collectedValues(
  values: McpCatalogueValue[],
  entered: Record<string, string>,
): Record<string, string> {
  const sent: Record<string, string> = {}
  for (const value of values) {
    if (value.set) continue
    const given = fieldValue(value, entered)
    if (given) sent[value.name] = given
  }
  return sent
}
