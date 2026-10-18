import type { McpCatalogueEntry } from "@/lib/hermes"

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
