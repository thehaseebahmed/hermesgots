/** How a flat model list orders itself; the providers list stays A to Z whatever this says. */
export type ModelSort = "name" | "price" | "context" | "benchlm"

export const MODEL_SORTS: Record<ModelSort, string> = {
  name: "A to Z",
  price: "Price",
  context: "Context",
  benchlm: "BenchLM Score",
}

/** The facts a sort ranks by — the picks `modelFacts` in lib/models.ts makes over a catalog. */
export interface SortFacts {
  context?: number
  cost?: number
  benchlm?: number
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** The numeric fact each sort orders by, or undefined if it doesn't apply. */
const SORT_VALUE: Record<Exclude<ModelSort, "name">, (f: SortFacts) => number | undefined> = {
  price: (f) => f.cost,
  context: (f) => f.context,
  benchlm: (f) => f.benchlm,
}

/** Price sorts ascending (cheapest first); context and benchlm sort descending. */
const SORT_ASC: Record<Exclude<ModelSort, "name">, boolean> = {
  price: true,
  context: false,
  benchlm: false,
}

/**
 * Orders a flat model list by one of `facts`. Unlisted models — models.dev doesn't say, or the
 * catalog hasn't loaded — keep A to Z order after the sorted ones, so a sort never hides a model.
 */
export function sortByFacts(
  sort: ModelSort,
  facts: (model: string) => SortFacts,
  models: string[],
) {
  if (sort === "name") return [...models].sort(byName.compare)
  const valueOf = SORT_VALUE[sort]
  const asc = SORT_ASC[sort]
  const keyed = models.map((model) => ({ model, value: valueOf(facts(model)) }))
  // Listed models first, in the picked order; the unlisted ones follow in A to Z order.
  const [listed, unlisted] = keyed.reduce<[typeof keyed, typeof keyed]>(
    ([yes, no], row) => (row.value === undefined ? [yes, [...no, row]] : [[...yes, row], no]),
    [[], []],
  )
  listed.sort((a, b) =>
    asc
      ? a.value! - b.value!
      : b.value! - a.value! || byName.compare(a.model, b.model),
  )
  unlisted.sort((a, b) => byName.compare(a.model, b.model))
  return [...listed, ...unlisted].map((row) => row.model)
}
