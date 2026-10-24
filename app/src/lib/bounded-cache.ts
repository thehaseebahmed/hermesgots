/**
 * A page-life cache with a bound, oldest entry first.
 *
 * A store of object URLs — or of whole files behind them — pins bytes for as long as it holds them,
 * and a clip can be tens of megabytes: a chat read through for a while would hold every one of them
 * until the page went away. So each store keeps a count and lets the oldest go, which `dispose` is
 * how it lets go of the bytes.
 *
 * Oldest-first is the safe order because a thread reads a file when it draws it, so the entry that
 * falls out is the one the thread drew longest ago — the one it has scrolled away from. A read that
 * comes back for a dropped key asks again and gets a new URL rather than a revoked one.
 */

export function boundedStore<T>({
  limit,
  dispose,
}: {
  limit: number
  dispose: (value: T) => void
}) {
  const entries = new Map<string, T>()
  const drop = (key: string) => {
    const value = entries.get(key)
    if (value === undefined) return
    entries.delete(key)
    dispose(value)
  }
  return {
    get(key: string) {
      const value = entries.get(key)
      // A read makes it the newest, so what falls out next is what nothing has asked for.
      if (value !== undefined) {
        entries.delete(key)
        entries.set(key, value)
      }
      return value
    },
    set(key: string, value: T) {
      const previous = entries.get(key)
      entries.delete(key)
      entries.set(key, value)
      if (previous !== undefined && previous !== value) dispose(previous)
      for (const oldest of entries.keys()) {
        if (entries.size <= limit) break
        drop(oldest)
      }
    },
    /** Whether the store holds a key, without counting as a read of it. */
    has(key: string) {
      return entries.has(key)
    },
    clear() {
      for (const key of [...entries.keys()]) drop(key)
    },
  }
}
