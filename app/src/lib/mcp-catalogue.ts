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
 * What a field holds: what was typed into it, else — for a value this Bot doesn't already hold — the
 * default the manifest pins, so a form submitted untouched still carries it and the manifest's own
 * `${NAME}` reference is not left unresolved. A field the user emptied stays empty rather than its
 * default again, and a value the Bot already holds starts empty whatever the manifest pins: what
 * stands is the Host's value, and the field is where typing over it replaces it.
 */
export function fieldValue(value: McpCatalogueValue, entered: Record<string, string>): string {
  const typed = entered[value.name]
  if (typed !== undefined) return typed
  return value.set ? "" : value.default || ""
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
 * field left empty — which is how the Host reads "nothing given", so a value the Bot already holds
 * stands as it is and one typed over it replaces it. A field left untouched sends the default it was
 * showing, so a default a manifest pins lands in the configuration rather than being left as the
 * manifest's own `${NAME}` reference.
 */
export function collectedValues(
  values: McpCatalogueValue[],
  entered: Record<string, string>,
): Record<string, string> {
  const sent: Record<string, string> = {}
  for (const value of values) {
    const given = fieldValue(value, entered)
    if (given) sent[value.name] = given
  }
  return sent
}
