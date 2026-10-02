import { updateProfile, type Profile } from "@/lib/db"
import { getModelInfo, type ModelInfo } from "@/lib/hermes"

const CATALOG_URL = "https://models.dev/api.json"

type Catalog = Record<string, { models?: Record<string, { limit?: { context?: unknown } }> }>

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

function contextOf(entry: { limit?: { context?: unknown } } | undefined) {
  const context = entry?.limit?.context
  return typeof context === "number" && context > 0 ? context : undefined
}

function matchIn(
  models: Record<string, { limit?: { context?: unknown } }> | undefined,
  model: string,
) {
  if (!models) return undefined
  const exact = contextOf(models[model])
  if (exact) return exact
  const full = normalise(model)
  const short = lastSegment(full)
  for (const [id, entry] of Object.entries(models)) {
    const candidate = normalise(id)
    if (candidate === full || lastSegment(candidate) === short) {
      const context = contextOf(entry)
      if (context) return context
    }
  }
  return undefined
}

/** The model's context window per models.dev, or undefined if it isn't listed (or unreachable). */
export async function findContextWindow({ provider, model }: ModelInfo) {
  if (!model) return undefined
  try {
    const data = await loadCatalog()
    // Hermes's provider ids don't always match models.dev's, so fall back to any provider.
    const own = provider ? matchIn(data[provider]?.models, model) : undefined
    if (own) return own
    for (const entry of Object.values(data)) {
      const context = matchIn(entry?.models, model)
      if (context) return context
    }
  } catch {
    // Offline, blocked or malformed: the user can still set it by hand.
  }
  return undefined
}

/**
 * Fills in the profile's context window from models.dev whenever the model behind it changes,
 * clearing it when the new model isn't listed so the user is asked for it.
 */
export async function syncContextWindow(profile: Profile) {
  if (!profile.baseUrl.trim()) return
  const info = await getModelInfo(profile)
  if (!info?.model) return
  const key = info.provider ? `${info.provider}/${info.model}` : info.model
  if (key === profile.contextModel) return
  const found = await findContextWindow(info)
  // Bots from before detection keep a hand-set window rather than losing it on the first sync.
  const keep = !profile.contextModel && !found && profile.contextWindow
  await updateProfile(profile.id, {
    contextModel: key,
    contextWindow: keep ? profile.contextWindow : found,
    contextSource: keep ? "manual" : found ? "models.dev" : undefined,
  })
}
