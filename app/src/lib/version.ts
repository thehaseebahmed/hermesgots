/** This build: `<package version> · <short commit>`. */
export const APP_VERSION = __APP_VERSION__

/** The oldest Gots plugin this app works with. Raise it when the app starts relying on a route,
 * field or behaviour that only a newer plugin has. 0.95.0 is the first whose media route signs a URL
 * (`POST …/media/url`, `plugin/media.py`) and accepts that signature in place of the key: the thread
 * draws every file an `<img>` or a `<video>` can from it, and there is no second way to read bytes. */
export const MIN_PLUGIN_VERSION = "0.95.0"

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
