/**
 * Where a bot's routes live, from its base URL alone. Import-free, so both chat screens' clients
 * and the unit tests that drive them read one rule.
 */

/** Root of the server (strips a trailing `/v1`), for non-OpenAI routes like `/health`. */
export function serverRoot(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

/** The profile `name` when the bot is a profile a multiplexing gateway serves at `/p/<name>/`. */
export function multiplexedProfile(baseUrl: string) {
  return serverRoot(baseUrl).match(/\/p\/([^/?#]+)$/)?.[1]
}

const PLUGIN_ROOT = "/api/plugins/memento"

/**
 * Where the Gots Hermes plugin serves its routes for this bot. Hermes registers its catch-all
 * for `/p/<profile>/...` before plugin routes, so a multiplexed profile's plugin is reached with
 * the profile inside the plugin's own prefix, which Hermes still scopes to that profile.
 */
export function pluginRoot(baseUrl: string) {
  const root = serverRoot(baseUrl)
  const profile = multiplexedProfile(baseUrl)
  if (!profile) return `${root}${PLUGIN_ROOT}`
  return `${root.slice(0, -`/p/${profile}`.length)}${PLUGIN_ROOT}/p/${profile}`
}
