// Pure model-id matchers. No imports, so Node can load this file directly in scripts/ tests.

export const normalise = (id: string) => id.toLowerCase().replace(/\./g, "-")
export const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1)

/** Whether two ids name the same model: Hermes vendors the ids it reports, a pick is bare. */
export const sameModel = (a: string, b: string) =>
  !!a && !!b && normalise(lastSegment(a)) === normalise(lastSegment(b))

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

/** Builds the normalised id → score map. Each row is keyed by its full id and its last segment. */
export function scoreMapOf(rows: ScoredRow[]): Map<string, number | undefined> {
  const map = new Map<string, number | undefined>()
  const entries = rows.flatMap((row) => {
    const id = idOf(row)
    return id ? [{ full: normalise(id), score: scoreOf(row) }] : []
  })
  // Exact ids and last segments claim their keys first, so a derived key never shadows a real row.
  for (const { full, score } of entries) {
    if (!map.has(full)) map.set(full, score)
    const short = lastSegment(full)
    if (!map.has(short)) map.set(short, score)
  }
  for (const { full, score } of entries) {
    for (const key of benchCandidates(full)) {
      if (!map.has(key)) map.set(key, score)
    }
  }
  return map
}

/**
 * Looks up a model's score: the first candidate spelling with a row, exact before last-segment.
 * The map is keyed by the same candidates, so a catalog id reaches a BenchLM row it spells differently.
 */
export function scoreFor(map: Map<string, number | undefined>, model: string): number | undefined {
  for (const key of benchCandidates(model)) {
    if (map.has(key)) return map.get(key)
  }
  return undefined
}

const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{4}|\d{4}|latest)$/
const VARIANT_SUFFIX = /-(preview|free)$/

const BENCHLM_KEY_BY_FAMILY: Record<string, string> = {
  gemma4: "gemma-4",
  beam: "reflection-beam",
}

const aliasFamily = (id: string) =>
  id
    .split("/")
    .map((segment) =>
      segment.replace(/^([a-z0-9]+)/, (token) => BENCHLM_KEY_BY_FAMILY[token] ?? token),
    )
    .join("/")

/**
 * Ids a catalog spelling might be stored under, most specific first. A lookup takes the first
 * candidate that has a BenchLM row, so an exact row always beats a looser reading.
 */
const candidateCache = new Map<string, string[]>()

export function benchCandidates(id: string): string[] {
  // Built once per id: a lookup runs for every row, and again for every keystroke while the
  // picker's search is typed.
  const cached = candidateCache.get(id)
  if (cached) return cached
  const base = normalise(id)
  const bases = [base]
  if (base.includes(":")) bases.push(base.replace(/:/g, "-"), base.split(":")[0])
  const out: string[] = []
  for (const b of bases) {
    for (const d of [b, b.replace(DATE_SUFFIX, "")]) {
      for (const v of [d, d.replace(VARIANT_SUFFIX, "")]) {
        out.push(v)
      }
    }
  }
  const bare = lastSegment(base)
  const aliased = [...out, bare].map(aliasFamily)
  const candidates = [...new Set([...out, bare, ...aliased])]
  candidateCache.set(id, candidates)
  return candidates
}
