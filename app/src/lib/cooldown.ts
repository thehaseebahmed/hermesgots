/**
 * Servers whose plugin lacks a route (an older plugin), each left alone for `ms` before it's asked
 * again. One per route, since a plugin can have one and not another.
 */
export function cooldown(ms = 5 * 60_000) {
  const since = new Map<string, number>()
  return {
    cooling: (key: string) => Date.now() - (since.get(key) ?? -Infinity) < ms,
    start: (key: string) => void since.set(key, Date.now()),
    clear: (key: string) => void since.delete(key),
  }
}
