import { useLiveQuery } from "dexie-react-hooks"

import { createStore } from "@/lib/store"
import { db, type ModelsDevCatalog, type Profile } from "@/lib/db"
import { getModelInfo, type ModelInfo } from "@/lib/hermes"
import { fullModel } from "@/lib/model-info"
import { lastSegment, normalise } from "@/lib/model-match"

const CATALOG_URL = "https://models.dev/api.json"
const CATALOG_ROW = "catalog"
const TTL_MS = 24 * 60 * 60 * 1000

interface CatalogModel {
  limit?: { context?: unknown }
  modalities?: { input?: unknown }
  reasoning?: unknown
  cost?: { input?: unknown; output?: unknown }
}

export type Catalog = Record<string, { models?: Record<string, CatalogModel> }>

/**
 * The last lookup couldn't reach models.dev and had no cached catalog to answer from, so
 * "not listed" isn't known. A cache we can serve — even a stale one — is an answer, so a
 * failed background refresh never sets this.
 */
const unreachable = createStore(false)
const setUnreachable = unreachable.set

/** Whether the last models.dev lookup couldn't reach it. */
export const useModelsDevUnreachable = unreachable.use

// The cached registry. It's large and rarely needed, so it lives in IndexedDB rather than
// memory: a fresh row answers with no I/O, a stale row answers at once and is refreshed in
// the background, and the row is only ever replaced by a validated response.

/** The payload must be the non-empty provider registry the lookups below walk. */
function isCatalog(data: unknown): data is Catalog {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    Object.keys(data).length > 0
  )
}

/** Fetches the registry; with an ETag a 304 means "unchanged", not empty. */
async function fetchRegistry(etag: string | undefined) {
  const response = await fetch(
    CATALOG_URL,
    etag ? { headers: { "If-None-Match": etag } } : undefined,
  )
  if (response.status === 304) return { catalog: undefined, etag: etag ?? "" }
  if (!response.ok) throw new Error(`models.dev responded ${response.status}`)
  const data: unknown = await response.json()
  if (!isCatalog(data)) throw new Error("models.dev returned an unexpected payload")
  return { catalog: data, etag: response.headers.get("ETag") ?? "" }
}

/** One shared background refresh at a time. */
let refreshing: Promise<void> | undefined

/**
 * Revalidates a stale row in the background: a fresher registry replaces the row, a 304 only
 * advances its freshness marker, and a failed or invalid response leaves the stale row in
 * place — the sheet keeps working from what it has until the next load past the TTL.
 */
function refreshCatalog(row: ModelsDevCatalog) {
  refreshing ??= (async () => {
    try {
      const { catalog, etag } = await fetchRegistry(row.etag)
      if (catalog)
        await db.modelsDevCatalog.put({
          id: CATALOG_ROW,
          data: catalog,
          etag,
          fetchedAt: Date.now(),
        })
      else await db.modelsDevCatalog.update(CATALOG_ROW, { fetchedAt: Date.now() })
      setUnreachable(false)
    } catch {
      // The stale row keeps serving; the next load past the TTL tries again.
    } finally {
      refreshing = undefined
    }
  })()
}

/** One shared cold fetch, reset on failure so the next lookup retries. */
let coldFetch: Promise<Catalog> | undefined

async function fetchAndCache(): Promise<Catalog> {
  const { catalog, etag } = await fetchRegistry(undefined)
  if (!catalog) throw new Error("models.dev answered 304 with no cached catalog to revalidate")
  await db.modelsDevCatalog.put({ id: CATALOG_ROW, data: catalog, etag, fetchedAt: Date.now() })
  setUnreachable(false)
  return catalog
}

/** models.dev's catalog, read from the device cache (see the section comment above). */
async function loadCatalog(): Promise<Catalog> {
  const row = await db.modelsDevCatalog.get(CATALOG_ROW)
  if (row) {
    if (Date.now() - row.fetchedAt >= TTL_MS) refreshCatalog(row)
    return row.data as Catalog
  }
  if (!coldFetch) {
    coldFetch = fetchAndCache().catch((error: unknown) => {
      coldFetch = undefined
      setUnreachable(true)
      throw error
    })
  }
  return coldFetch
}

/**
 * Warms the cache when the app opens: a fresh row costs one read, a stale one is refreshed in
 * the background, and a fetch that can't land changes nothing — the sheet keeps serving what
 * it has. The sheet itself never fetches.
 */
export function warmCatalog() {
  void loadCatalog().catch(() => {})
}

// `anthropic/Claude-Sonnet-4.5` and `claude-sonnet-4-5` should meet; see model-match.ts.
export { normalise, lastSegment } from "@/lib/model-match"

/** Whether two ids name the same model: Hermes vendors the ids it reports, a pick is bare. */
export function sameModel(a: string, b: string) {
  if (!a || !b) return false
  return normalise(lastSegment(a)) === normalise(lastSegment(b))
}

function contextOf(entry: CatalogModel | undefined) {
  const context = entry?.limit?.context
  return typeof context === "number" && context > 0 ? context : undefined
}

function imageInputOf(entry: CatalogModel | undefined) {
  const input = entry?.modalities?.input
  return Array.isArray(input) ? input.includes("image") : undefined
}

function reasoningOf(entry: CatalogModel | undefined) {
  return typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined
}

/** The upper bound of each cost band, in blended USD per million tokens. */
const COST_BANDS = [2, 8, 25, 80]

/** The cost slots a model row draws: one per band, the top band's own slot included. */
export const MAX_COST_TIER = COST_BANDS.length + 1

/**
 * The model's cost band, 1–5, from the blended price (5×input + output): `$` under 2, `$$` to 8,
 * `$$$` to 25, `$$$$` to 80, `$$$$$` above that. Unknown when either price is missing.
 */
function costTierOf(entry: CatalogModel | undefined) {
  const cost = entry?.cost
  const input = typeof cost?.input === "number" ? cost.input : undefined
  const output = typeof cost?.output === "number" ? cost.output : undefined
  if (input === undefined || output === undefined) return undefined
  const blended = 5 * input + output
  const band = COST_BANDS.findIndex((max) => blended < max)
  return band === -1 ? COST_BANDS.length + 1 : band + 1
}

/** The blended USD per million tokens behind the cost band, or undefined when either price is missing. */
function blendedCostOf(entry: CatalogModel | undefined) {
  const cost = entry?.cost
  const input = typeof cost?.input === "number" ? cost.input : undefined
  const output = typeof cost?.output === "number" ? cost.output : undefined
  if (input === undefined || output === undefined) return undefined
  return 5 * input + output
}

function matchIn<T>(
  models: Record<string, CatalogModel> | undefined,
  model: string,
  pick: (entry: CatalogModel | undefined) => T | undefined,
) {
  if (!models) return undefined
  const exact = pick(models[model])
  if (exact !== undefined) return exact
  const full = normalise(model)
  const short = lastSegment(full)
  for (const [id, entry] of Object.entries(models)) {
    const candidate = normalise(id)
    if (candidate === full || lastSegment(candidate) === short) {
      const value = pick(entry)
      if (value !== undefined) return value
    }
  }
  return undefined
}

/** The first value *pick* finds for the model: under its own provider, then under any. */
function findIn<T>(
  data: Catalog,
  { provider, model }: ModelRef,
  pick: (entry: CatalogModel | undefined) => T | undefined,
) {
  if (!model) return undefined
  // Hermes's provider ids don't always match models.dev's, so fall back to any provider.
  const own = provider ? matchIn(data[provider]?.models, model, pick) : undefined
  if (own !== undefined) return own
  for (const entry of Object.values(data)) {
    const value = matchIn(entry?.models, model, pick)
    if (value !== undefined) return value
  }
  return undefined
}

type ModelRef = Pick<ModelInfo, "provider" | "model">

/** What models.dev says about the model, or undefined if it isn't listed. Throws when unreachable. */
async function lookUp<T>(info: ModelRef, pick: (entry: CatalogModel | undefined) => T | undefined) {
  if (!info.model) return undefined
  return findIn(await loadCatalog(), info, pick)
}

/** The model's context window per models.dev. */
export const findContextWindow = (info: ModelRef) => lookUp(info, contextOf)

/** Whether the model takes images (`modalities.input`), unknown when models.dev doesn't say. */
export const findImageInput = (info: ModelRef) => lookUp(info, imageInputOf)

export interface ModelFacts {
  /** Whether models.dev lists the model at all; an unlisted model has nothing else to show. */
  listed?: boolean
  context?: number
  vision?: boolean
  reasoning?: boolean
  /** The model's cost band, 1–5; see COST_BANDS. */
  tier?: number
  /** The blended USD per million tokens (`5×input + output`) the cost band is ranked by. */
  cost?: number
}

/** Facts per registry object, so re-renders (search typing) don't re-walk all of models.dev. */
const factsCache = new WeakMap<Catalog, Map<string, ModelFacts>>()

/** What the cached registry says about a listed model, for the model sheet's detail line. */
export function modelFacts(catalog: Catalog | undefined, info: ModelRef): ModelFacts {
  if (!catalog || !info.model) return {}
  let byModel = factsCache.get(catalog)
  if (!byModel) factsCache.set(catalog, (byModel = new Map()))
  const key = `${info.provider ?? ""}/${info.model}`
  let facts = byModel.get(key)
  if (!facts) {
    facts = {
      listed: findIn(catalog, info, (entry) => (entry ? true : undefined)) === true,
      context: findIn(catalog, info, contextOf),
      vision: findIn(catalog, info, imageInputOf),
      reasoning: findIn(catalog, info, reasoningOf),
      tier: findIn(catalog, info, costTierOf),
      cost: findIn(catalog, info, blendedCostOf),
    }
    byModel.set(key, facts)
  }
  return facts
}

/** The cached registry itself, live: the model sheet renders its facts from this. */
export function useModelCatalog() {
  const catalog = useLiveQuery(() => db.modelsDevCatalog.get(CATALOG_ROW))
  return catalog?.data as Catalog | undefined
}

/**
 * Fills in the profile's context window from models.dev whenever the model behind it changes,
 * clearing it when the new model isn't listed. When models.dev can't be
 * reached the profile is left alone, so the next sync looks again. Each device looks it up for
 * itself, so it's written without moving the bot's sync clock.
 */
export async function syncContextWindow(profile: Profile) {
  if (!profile.baseUrl.trim()) return
  const info = await getModelInfo(profile)
  if (!info?.model) return
  const key = fullModel({ provider: info.provider, model: info.model })
  if (key === profile.contextModel) {
    // Bots from before image detection learn it once.
    if (profile.imageInput === undefined) {
      const imageInput = await findImageInput(info).catch(() => undefined)
      if (imageInput !== undefined) await db.profiles.update(profile.id, { imageInput })
    }
    return
  }
  let found, imageInput
  try {
    ;[found, imageInput] = await Promise.all([findContextWindow(info), findImageInput(info)])
  } catch {
    // The old model's window would be wrong for this one; the next sync looks the new one up.
    if (profile.contextModel) {
      await db.profiles.update(profile.id, { contextModel: undefined, contextWindow: undefined })
    }
    return
  }
  await db.profiles.update(profile.id, { contextModel: key, contextWindow: found, imageInput })
}
