/**
 * A sort, everywhere in the app: the fact a list ranks by and the arrow it reads in (ADR 0091).
 * `asc` is A→Z, oldest→newest, cheapest→dearest; `desc` is the other way. Each key carries the
 * way it reads best, which is what picking it in the menu is understood to mean, and a second tap
 * on the key already chosen flips the arrow instead of choosing it again.
 */

export type SortDir = "asc" | "desc"

/** One thing a list can rank by, with the way that key reads best. */
export interface SortKey<K extends string> {
  key: K
  label: string
  /** The arrow this key takes when it is picked, and when a stored value names the key alone. */
  dir: SortDir
}

/** A list's order: the key it ranks by, and the arrow it reads in. */
export interface Sort<K extends string> {
  key: K
  dir: SortDir
}

/** The opposite arrow. */
export const flipped = (dir: SortDir): SortDir => (dir === "asc" ? "desc" : "asc")

/** The arrow in words, for a name a screen reader hears: the same two spellings everywhere. */
export const dirWord = (dir: SortDir) => (dir === "asc" ? "ascending" : "descending")

/** Where a key reads best, or the first key's own when a stored value names none of them. */
export function defaultSort<K extends string>(keys: readonly SortKey<K>[], key?: string): Sort<K> {
  const found = keys.find((one) => one.key === key) ?? keys[0]
  return { key: found.key, dir: found.dir }
}

/**
 * What a list reads from what a device stored. `legacy` names the values an older build wrote —
 * the direction it meant baked into the key — so a pick made before this rule keeps its order on
 * the first open after it.
 */
export function readSort<K extends string>(
  keys: readonly SortKey<K>[],
  stored: { key?: string; dir?: string },
  legacy: Record<string, Sort<K>> = {},
): Sort<K> {
  const known = keys.some((one) => one.key === stored.key)
  if (!known) return legacy[stored.key ?? ""] ?? defaultSort(keys)
  const dir = stored.dir === "asc" || stored.dir === "desc" ? stored.dir : undefined
  return { key: stored.key as K, dir: dir ?? keys.find((one) => one.key === stored.key)!.dir }
}

/** What a tap on a row of the menu does: the chosen key flips, any other key is picked. */
export function toggleSort<K extends string>(
  current: Sort<K>,
  picked: K,
  keys: readonly SortKey<K>[],
): Sort<K> {
  if (picked !== current.key) return defaultSort(keys, picked)
  return { key: current.key, dir: flipped(current.dir) }
}

/**
 * A comparator's answer read in an arrow: `desc` turns it round, so a list ranks by one function
 * and says its direction in one place.
 */
export function withDir(compare: number, dir: SortDir): number {
  return dir === "asc" || !compare ? compare : -compare
}
