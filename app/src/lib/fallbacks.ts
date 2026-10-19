import { getFallbackModels, setFallbackModels, type Fallback } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"

/**
 * The bot's fallback models on its host, in the order it would try them after the main model (the
 * Gots plugin's `fallbacks`, which is Hermes's own failover chain). A host whose plugin predates
 * the route shows no rows at all.
 */
const FALLBACKS: HostRoute<Fallback[]> = {
  feature: "fallbacks",
  what: "the fallback models",
  read: getFallbackModels,
  write: setFallbackModels,
}

/**
 * A bot's fallback models, read from its host once the plugin says it has the route, and the way
 * its settings record new ones. `list` is the chain to show, `saving` whether a write is on its way.
 */
export function useFallbackModels(profile?: { baseUrl: string; apiKey: string } | null) {
  const { value: list, supported, saving, save } = useHostRecord(profile, FALLBACKS, [])
  return { list, supported, saving, save }
}
