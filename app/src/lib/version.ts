/** This build: `<package version> · <short commit>`. */
export const APP_VERSION = __APP_VERSION__

/** The oldest Gots plugin this app works with. Raise it when the app starts relying on a route,
 * field or behaviour that only a newer plugin has. */
export const MIN_PLUGIN_VERSION = "0.76.0"

function parts(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match ? match.slice(1).map(Number) : null
}

/** Whether a plugin version is older than the app needs; an unknown or unreadable one isn't. */
export function pluginOutdated(version: string | undefined) {
  const have = version ? parts(version) : null
  const need = parts(MIN_PLUGIN_VERSION)
  if (!have || !need) return false
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] < need[i]
  }
  return false
}
