/** How a flat model list orders itself; the providers list stays A to Z whatever this says. */
export type ModelSort = "name" | "price" | "context"

export const MODEL_SORTS: Record<ModelSort, string> = {
  name: "A to Z",
  price: "Price",
  context: "Context",
}

/** The facts a sort ranks by — the picks `modelFacts` in lib/models.ts makes over a catalog. */
export interface SortFacts {
  context?: number
  cost?: number
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

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
  const keyed = models.map((model) => ({
    model,
    value: sort === "price" ? facts(model).cost : facts(model).context,
  }))
  // Listed models first, in the picked order (cheapest first, largest window first); the
  // unlisted ones follow in A to Z order.
  const [listed, unlisted] = keyed.reduce<[typeof keyed, typeof keyed]>(
    ([yes, no], row) => (row.value === undefined ? [yes, [...no, row]] : [[...yes, row], no]),
    [[], []],
  )
  listed.sort((a, b) =>
    sort === "price"
      ? a.value! - b.value!
      : b.value! - a.value! || byName.compare(a.model, b.model),
  )
  unlisted.sort((a, b) => byName.compare(a.model, b.model))
  return [...listed, ...unlisted].map((row) => row.model)
}
