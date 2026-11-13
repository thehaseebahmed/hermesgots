/**
 * models.dev's catalogue, reduced to what the community board may count.
 *
 * The app reads the same payload for a model's facts (`src/lib/models.ts`); here it is only asked
 * "is this a real model, and what is it called?" and "is this a real provider?" — because a report
 * carries the host's own words, and the board is a public page: a name nobody can look up, or an
 * advertisement typed into a provider field, must never be drawn on it. The payload is ~6 MB, so the
 * ids are kept as sorted lists in the community store — for a day when a read worked, and for a
 * shorter window when one didn't, since the board is unauthenticated and an outage must not turn
 * every visitor into a 6 MB fetch.
 */

import type { RegistryStore } from "./registry.ts"

export const MODELS_DEV_URL = "https://models.dev/api.json"
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
/** A read that failed is remembered this long, so an outage costs one fetch a window, not one a request. */
export const CATALOG_RETRY_MS = 10 * 60_000

const CATALOG_KEY = "models-dev"

/** The catalogue's model ids, by the key a reported id is looked up with. */
export type Models = ReadonlyMap<string, string>

/** What models.dev says exists: its models by lookup key, and the providers it lists. */
export interface Catalog {
  models: Models
  providers: ReadonlySet<string>
}

interface CatalogRow {
  /** Sorted and canonically spelled; null when the last read failed and nothing older is known. */
  models: string[] | null
  providers: string[] | null
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
 * The registry as the board reads it. Null when the payload isn't the provider registry
 * `src/lib/models.ts` reads, or holds no model id at all: a caller can then tell "nothing is real"
 * from "nothing could be read", and only the second fails open.
 */
export function catalogFrom(payload: unknown): Catalog | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const models = new Map<string, string>()
  const providers = new Set<string>()
  for (const [id, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue
    const listed = (raw as { models?: unknown }).models
    if (!listed || typeof listed !== "object" || Array.isArray(listed)) continue
    // A provider the catalogue names is one the board can vouch for, so its bar may be drawn.
    const provider = id.trim().toLowerCase()
    if (provider) providers.add(provider)
    for (const spelling of Object.keys(listed)) {
      const model = spelling.toLowerCase().split("/").pop() ?? ""
      const key = modelKey(model)
      if (!key) continue
      // Two providers can list one model, and the board names it once: the first spelling in sorted
      // order is the one served, so the answer never depends on which provider was walked first.
      const held = models.get(key)
      if (held === undefined || model < held) models.set(key, model)
    }
  }
  return models.size > 0 ? { models, providers } : null
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

/** The catalogue a stored row holds; the model map is rebuilt from the spellings it lists. */
function catalogFromRow(row: CatalogRow): Catalog {
  return {
    models: new Map((row.models ?? []).map((id) => [modelKey(id), id])),
    providers: new Set(row.providers ?? []),
  }
}

/** The cached row, or nothing when the blob isn't one this module wrote or can't be read at all. */
async function cachedRow(store: RegistryStore): Promise<CatalogRow | null> {
  try {
    const entry = await store.getWithMetadata(CATALOG_KEY, { type: "json" })
    const row = entry?.data as CatalogRow | undefined
    if (!row || typeof row.at !== "number") return null
    // An empty list is no catalogue: reading one would empty the board without anyone asking.
    const usable = (ids: unknown) => ids === null || (Array.isArray(ids) && ids.length > 0)
    return usable(row.models) && usable(row.providers) ? row : null
  } catch {
    // A store that can't be read is a catalogue nobody knows, which the caller already handles.
    return null
  }
}

async function remember(store: RegistryStore, lists: Omit<CatalogRow, "at">, at: number) {
  try {
    await store.setJSON(CATALOG_KEY, { ...lists, at } satisfies CatalogRow)
  } catch {
    // What is in hand is the answer either way; the next request reads it again.
  }
}

/**
 * The catalogue, from the store. A failed or unreadable read keeps the stale ids serving — a third
 * party's outage costing a real user their tokens is worse than a day-old list — and is remembered
 * for `CATALOG_RETRY_MS`, so it can't be retried per visitor; with nothing on file and no answer at
 * all it returns null, and the caller filters nothing.
 */
export async function knownCatalog(
  store: RegistryStore,
  now: number,
  load: () => Promise<unknown> = fetchModelsDev,
): Promise<Catalog | null> {
  const row = await cachedRow(store)
  const held = row ? catalogFromRow(row) : null
  if (row && now - row.at < (held?.models.size ? CATALOG_TTL_MS : CATALOG_RETRY_MS)) return held
  const fresh = await load()
    .then(catalogFrom)
    .catch(() => null)
  await remember(
    store,
    {
      models: fresh ? [...fresh.models.values()].sort() : (row?.models ?? null),
      providers: fresh ? [...fresh.providers].sort() : (row?.providers ?? null),
    },
    now,
  )
  return fresh ?? held
}
