/**
 * A page-life cache with a bound, oldest entry first: a store of object URLs, or of the files behind
 * them, pins bytes for as long as it holds them, and a thread read through for a while would hold
 * every one. Oldest-first is the safe order because a thread reads a file when it draws it, so what
 * falls out is what it has scrolled away from.
 */

export function boundedStore<T>({
  limit,
  dispose,
}: {
  limit: number
  /** How a value's bytes are let go of; a store of plain values needs none. */
  dispose?: (value: T) => void
}) {
  const entries = new Map<string, T>()
  const drop = (key: string) => {
    const value = entries.get(key)
    if (value === undefined) return
    entries.delete(key)
    dispose?.(value)
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
      if (previous !== undefined && previous !== value) dispose?.(previous)
      for (const oldest of entries.keys()) {
        if (entries.size <= limit) break
        drop(oldest)
      }
    },
    /** Whether the store holds a key, without counting as a read of it. */
    has(key: string) {
      return entries.has(key)
    },
  }
}
