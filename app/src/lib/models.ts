import { updateProfile, type Profile } from "@/lib/db"
import { getModelInfo, type ModelInfo } from "@/lib/hermes"

const CATALOG_URL = "https://models.dev/api.json"

interface CatalogModel {
  limit?: { context?: unknown }
  modalities?: { input?: unknown }
}

type Catalog = Record<string, { models?: Record<string, CatalogModel> }>

let catalog: Promise<Catalog> | undefined

/** models.dev's catalog, fetched once per page load (it's large and rarely needed). */
function loadCatalog() {
  catalog ??= fetch(CATALOG_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`models.dev responded ${response.status}`)
      return response.json() as Promise<Catalog>
    })
    .catch((error) => {
      catalog = undefined
      throw error
    })
  return catalog
}

/** `anthropic/Claude-Sonnet-4.5` and `claude-sonnet-4-5` should meet. */
const normalise = (id: string) => id.toLowerCase().replace(/\./g, "-")
const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1)

function contextOf(entry: CatalogModel | undefined) {
  const context = entry?.limit?.context
  return typeof context === "number" && context > 0 ? context : undefined
}

function imageInputOf(entry: CatalogModel | undefined) {
  const input = entry?.modalities?.input
  return Array.isArray(input) ? input.includes("image") : undefined
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

/** What models.dev says about the model, or undefined if it isn't listed (or unreachable). */
async function lookUp<T>(
  { provider, model }: ModelInfo,
  pick: (entry: CatalogModel | undefined) => T | undefined,
) {
  if (!model) return undefined
  try {
    const data = await loadCatalog()
    // Hermes's provider ids don't always match models.dev's, so fall back to any provider.
    const own = provider ? matchIn(data[provider]?.models, model, pick) : undefined
    if (own !== undefined) return own
    for (const entry of Object.values(data)) {
      const value = matchIn(entry?.models, model, pick)
      if (value !== undefined) return value
    }
  } catch {
    // Offline, blocked or malformed: the user can still set it by hand.
  }
  return undefined
}

/** The model's context window per models.dev. */
export const findContextWindow = (info: ModelInfo) => lookUp(info, contextOf)

/** Whether the model takes images (`modalities.input`), unknown when models.dev doesn't say. */
export const findImageInput = (info: ModelInfo) => lookUp(info, imageInputOf)

/**
 * Fills in the profile's context window from models.dev whenever the model behind it changes,
 * clearing it when the new model isn't listed so the user is asked for it.
 */
export async function syncContextWindow(profile: Profile) {
  if (!profile.baseUrl.trim()) return
  const info = await getModelInfo(profile)
  if (!info?.model) return
  const key = info.provider ? `${info.provider}/${info.model}` : info.model
  if (key === profile.contextModel) {
    // Bots from before image detection learn it once.
    if (profile.imageInput === undefined) {
      const imageInput = await findImageInput(info)
      if (imageInput !== undefined) await updateProfile(profile.id, { imageInput })
    }
    return
  }
  const [found, imageInput] = await Promise.all([findContextWindow(info), findImageInput(info)])
  // Bots from before detection keep a hand-set window rather than losing it on the first sync.
  const keep = !profile.contextModel && !found && profile.contextWindow
  await updateProfile(profile.id, {
    contextModel: key,
    contextWindow: keep ? profile.contextWindow : found,
    contextSource: keep ? "manual" : found ? "models.dev" : undefined,
    imageInput,
  })
}
