/**
 * models.dev's catalogue, reduced to the set of model ids the community board may count.
 *
 * The app reads the same payload for a model's facts (`src/lib/models.ts`); here it is only asked
 * "is this a real model?", because a host reports whatever its own endpoint called the model it ran
 * and the board must not count a name no catalogue lists. The payload is ~6 MB, so the ids are kept
 * as one sorted list in the community store for a day and no request fetches it twice.
 */

import type { RegistryStore } from "./registry.ts"

export const MODELS_DEV_URL = "https://models.dev/api.json"
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

/** The model ids models.dev lists: the set the board filters by (`community.ts`). */
export type Known = ReadonlySet<string>

/** The row the ids are cached in, in the community store. */
const CATALOG_KEY = "models-dev"

interface CatalogRow {
  /** Sorted, so the same catalogue is always stored as the same bytes. */
  models: string[]
  at: number
}

/**
 * The lookup key for a model id: lower case, its last `/` segment, `.` to `-`. The catalogue lists
 * `deepseek/deepseek-v4-pro` and `deepseek-v4.1-flash` where a host reports `deepseek-v4-pro` and
 * `deepseek-v4.1-flash`, so both spellings meet on one key — the rule `src/lib/model-match.ts`
 * matches by.
 */
export function modelKey(raw: string): string {
  const id = raw.toLowerCase()
  return id.slice(id.lastIndexOf("/") + 1).replace(/\./g, "-")
}

/**
 * Every model id in the registry, as keys. Null when the payload isn't the provider registry
 * `src/lib/models.ts` reads, or holds no id at all: a caller can then tell "nothing is real" from
 * "nothing could be read", and only the second fails open.
 */
export function knownModels(payload: unknown): Known | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const ids = new Set<string>()
  for (const provider of Object.values(payload as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue
    const models = (provider as { models?: unknown }).models
    if (!models || typeof models !== "object" || Array.isArray(models)) continue
    for (const id of Object.keys(models)) ids.add(modelKey(id))
  }
  return ids.size > 0 ? ids : null
}

/** The registry as models.dev serves it. */
export async function fetchModelsDev(url = MODELS_DEV_URL): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`models.dev responded ${response.status}`)
  return response.json()
}

/** The cached row, or nothing when the blob isn't one this module wrote. */
async function cachedRow(store: RegistryStore): Promise<CatalogRow | null> {
  const entry = await store.getWithMetadata(CATALOG_KEY, { type: "json" })
  const row = entry?.data as CatalogRow | undefined
  return row && Array.isArray(row.models) && typeof row.at === "number" ? row : null
}

/**
 * The catalogue's ids, from a cache a day long. A refresh that fails or answers something
 * unreadable keeps the stale set serving, since a third party's outage costing a real user their
 * tokens is worse than a day-old set; with no cache and no answer at all it returns null, and the
 * caller filters nothing.
 */
export async function knownModelIds(
  store: RegistryStore,
  now: number,
  load: () => Promise<unknown> = fetchModelsDev,
): Promise<Known | null> {
  const row = await cachedRow(store)
  const cached = row ? new Set(row.models) : null
  if (row && cached && now - row.at < CATALOG_TTL_MS) return cached
  const fresh = await load()
    .then(knownModels)
    .catch(() => null)
  if (!fresh) return cached
  await store.setJSON(CATALOG_KEY, { models: [...fresh].sort(), at: now } satisfies CatalogRow)
  return fresh
}
