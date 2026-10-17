import { MISSING_ROUTE_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import { getPluginFeatures, HermesError, type HermesConfig } from "@/lib/hermes"

/**
 * Servers whose plugin lacks a route (an older plugin), each left alone for `ms` before it's asked
 * again. One per route, since a plugin can have one and not another.
 */
export function cooldown(ms = MISSING_ROUTE_MS) {
  const since = new Map<string, number>()
  return {
    cooling: (key: string) => Date.now() - (since.get(key) ?? -Infinity) < ms,
    start: (key: string) => void since.set(key, Date.now()),
    clear: (key: string) => void since.delete(key),
  }
}

/**
 * Whether a failed read means the plugin lacks the route (an older one) rather than a blip: a busy
 * host, a dropped connection or a refused key is asked again on the next read, not left 5 minutes.
 * Hermes's 404 for an unknown route skips its CORS middleware, so it can arrive with no status.
 */
export async function lacksRoute(server: HermesConfig, error: unknown, feature: string) {
  if (!(error instanceof HermesError) || (error.status && error.status !== 404)) return false
  // Bounded like every other read to a host: a probe that hangs would leave the caller's promise
  // unsettled for as long as the page lives, and its caller reads a timeout as "not that answer".
  return getPluginFeatures(server, AbortSignal.timeout(READ_TIMEOUT_MS)).then(
    (features) => !features.includes(feature),
    () => false,
  )
}
