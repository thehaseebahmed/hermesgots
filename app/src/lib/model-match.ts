// Pure model-id matchers. No imports, so Node can load this file directly in scripts/ tests.

export const normalise = (id: string) => id.toLowerCase().replace(/\./g, "-")
export const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1)

/** A ranking row as BenchLM returns it: a key/slug/name and a numeric score. */
export interface ScoredRow {
  modelKey?: unknown
  slug?: unknown
  name?: unknown
  score?: unknown
}

function scoreOf(row: ScoredRow): number | undefined {
  const score = row.score
  return typeof score === "number" && Number.isFinite(score) ? score : undefined
}

/** A row's id: modelKey, then slug, then name. */
function idOf(row: ScoredRow): string | undefined {
  const id = row.modelKey ?? row.slug ?? row.name
  return typeof id === "string" && id.trim() ? id.trim() : undefined
}

/** Builds the normalised id → score map. Full ids take priority over last segments. */
export function scoreMapOf(rows: ScoredRow[]): Map<string, number | undefined> {
  const map = new Map<string, number | undefined>()
  for (const row of rows) {
    const id = idOf(row)
    if (!id) continue
    const full = normalise(id)
    const short = lastSegment(full)
    const score = scoreOf(row)
    if (!map.has(full)) map.set(full, score)
    if (!map.has(short)) map.set(short, score)
  }
  return map
}

/** Looks up a model's score in a built map: exact, then last segment. */
export function scoreFor(map: Map<string, number | undefined>, model: string): number | undefined {
  const full = normalise(model)
  return map.get(full) ?? map.get(lastSegment(full))
}
