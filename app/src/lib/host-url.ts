/**
 * Where a bot's routes live, from its base URL alone. Import-free, so both chat screens' clients
 * and the unit tests that drive them read one rule.
 */

/**
 * The scheme a typed address wears, lowercased — `http` in `http://100.64.0.2:8642` — or undefined
 * for one that names none, since a host and a port (`bot.example:8642`) are a scheme of their own to
 * a URL parser. One rule for every reader of a typed address: whether it is the plain http a charm
 * calls its host on, whether an image's is https, and the two rows that read a pasted host at all.
 */
export function schemeOf(url: string) {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim())?.[1]?.toLowerCase()
}

/**
 * Root of the server (strips a trailing `/v1`), for non-OpenAI routes like `/health`. A query or a
 * fragment is no part of the path a route is built on, so it goes first: an address pasted with one
 * is still the server it names.
 */
export function serverRoot(baseUrl: string) {
  return baseUrl
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "")
}

/** The profile `name` when the bot is a profile a multiplexing gateway serves at `/p/<name>/`. */
export function multiplexedProfile(baseUrl: string) {
  return serverRoot(baseUrl).match(/\/p\/([^/?#]+)$/)?.[1]
}

export const PLUGIN_ROOT = "/api/plugins/gots"

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
