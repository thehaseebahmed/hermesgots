/**
 * models.dev's catalogue, reduced to the model ids the community board may count.
 *
 * The app reads the same payload for a model's facts (`src/lib/models.ts`); here it is only asked
 * "is this a real model, and what is it called?", because a host reports whatever its own endpoint
 * called the model it ran and the board must show a name the catalogue lists or none at all. The
 * payload is ~6 MB, so the ids are kept as one sorted list in the community store — for a day when a
 * read worked, and for a shorter window when one didn't, since the board is public and unauthenticated
 * and an outage must not turn every visitor into a 6 MB fetch.
 */

import type { RegistryStore } from "./registry.ts"

export const MODELS_DEV_URL = "https://models.dev/api.json"
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
/** A read that failed is remembered this long, so an outage costs one fetch a window, not one a request. */
export const CATALOG_RETRY_MS = 10 * 60_000

const CATALOG_KEY = "models-dev"

/** The catalogue's ids, by the key a reported id is looked up with. */
export type Known = ReadonlyMap<string, string>

interface CatalogRow {
  /** The ids, sorted and canonically spelled; null when the last read failed and nothing is known. */
  models: string[] | null
  at: number
}

const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/

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
 * The keys a reported id is tried under, most exact first: its own spelling, then the same with a
 * snapshot date dropped (`-20250929`, `-2025-09-29`, `-latest`), which is how a provider names one
 * model two ways. A dated id is a real model the catalogue lists by its family.
 */
export function modelKeys(raw: string): string[] {
  const key = modelKey(raw)
  const family = key.replace(DATE_SUFFIX, "")
  return family === key ? [key] : [key, family]
}

/**
 * Every model id in the registry, by key. Null when the payload isn't the provider registry
 * `src/lib/models.ts` reads, or holds no id at all: a caller can then tell "nothing is real" from
 * "nothing could be read", and only the second fails open.
 */
export function knownModels(payload: unknown): Known | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const known = new Map<string, string>()
  for (const provider of Object.values(payload as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue
    const models = (provider as { models?: unknown }).models
    if (!models || typeof models !== "object" || Array.isArray(models)) continue
    for (const raw of Object.keys(models)) {
      const name = raw.toLowerCase().split("/").pop() ?? ""
      const key = modelKey(name)
      if (!key) continue
      // Two providers can list one model, and the board names it once: the first spelling in sorted
      // order is the one served, so the answer never depends on which provider was walked first.
      const held = known.get(key)
      if (held === undefined || name < held) known.set(key, name)
    }
  }
  return known.size > 0 ? known : null
}

/**
 * How long models.dev has to answer. The read happens inside a request (a report, or a board being
 * built), so a reply that never comes would be a request that never ends: give up, and the caller
 * filters with the stale set or not at all.
 */
export const CATALOG_TIMEOUT_MS = 8_000

/** The registry as models.dev serves it. */
export async function fetchModelsDev(url = MODELS_DEV_URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`models.dev responded ${response.status}`)
  return response.json()
}

/** The ids a stored row holds; the map is rebuilt from the canonical spellings it lists. */
function knownFrom(ids: string[]): Known {
  return new Map(ids.map((id) => [modelKey(id), id]))
}

/** The cached row, or nothing when the blob isn't one this module wrote or can't be read at all. */
async function cachedRow(store: RegistryStore): Promise<CatalogRow | null> {
  try {
    const entry = await store.getWithMetadata(CATALOG_KEY, { type: "json" })
    const row = entry?.data as CatalogRow | undefined
    if (!row || typeof row.at !== "number") return null
    // An empty list is no catalogue: reading one would empty the board without anyone asking.
    return row.models === null || (Array.isArray(row.models) && row.models.length > 0) ? row : null
  } catch {
    // A store that can't be read is a catalogue nobody knows, which the caller already handles.
    return null
  }
}

async function remember(store: RegistryStore, models: string[] | null, at: number) {
  try {
    await store.setJSON(CATALOG_KEY, { models, at } satisfies CatalogRow)
  } catch {
    // The ids in hand are the answer either way; the next request reads them again.
  }
}

/**
 * The catalogue's ids, from the store. A failed or unreadable read keeps the stale ids serving —
 * a third party's outage costing a real user their tokens is worse than a day-old list — and is
 * remembered for `CATALOG_RETRY_MS`, so it can't be retried per visitor; with nothing on file and no
 * answer at all it returns null, and the caller filters nothing.
 */
export async function knownModelIds(
  store: RegistryStore,
  now: number,
  load: () => Promise<unknown> = fetchModelsDev,
): Promise<Known | null> {
  const row = await cachedRow(store)
  const held = row?.models ? knownFrom(row.models) : null
  if (row && now - row.at < (held ? CATALOG_TTL_MS : CATALOG_RETRY_MS)) return held
  const fresh = await load()
    .then(knownModels)
    .catch(() => null)
  await remember(store, fresh ? [...fresh.values()].sort() : (row?.models ?? null), now)
  return fresh ?? held
}
