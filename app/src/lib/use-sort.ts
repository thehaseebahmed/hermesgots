import { useLiveQuery } from "dexie-react-hooks"
import { useMemo } from "react"

import { getSettings, saveSettings, type Settings } from "@/lib/db"
import { quietly } from "@/lib/report"
import { readSort, type Sort, type SortKey } from "@/lib/sort"

/**
 * A list's order, kept on this device: the two settings fields read as one `Sort`, and a setter that
 * writes them back. Every sortable list reads it from here, so the four agree about the pair, the
 * legacy values an older build wrote, and what a failed write says (ADR 0091).
 *
 * The query answers a *string*, not the pair: `dexie-react-hooks` re-renders whenever an emission is
 * not `===` the last one, and a fresh `{ key, dir }` object is never equal. Every write to
 * `db.settings` would then re-render every list — and the sync pass writes `syncedAt` on each tick.
 * A settled string is what makes an unrelated write cost nothing, and the `Sort` built from it is
 * memoised so a consumer's own memo (the Library's sort of its tree) can hold.
 */
const NO_LEGACY: Record<string, Sort<string>> = {}

export function useStoredSort<K extends string>(
  keys: readonly SortKey<K>[],
  /** The settings fields this list keeps its order in, as `[key, direction]`. */
  fields: readonly [keyof Settings, keyof Settings],
  legacy: Record<string, Sort<K>> = NO_LEGACY as Record<string, Sort<K>>,
): [Sort<K>, (sort: Sort<K>) => void] {
  const [keyField, dirField] = fields
  const packed = useLiveQuery(async () => {
    const settings = await getSettings()
    const key = settings[keyField]
    const dir = settings[dirField]
    return `${key ?? ""}\u0000${dir ?? ""}`
  }, [])
  const [key, dir] = (packed ?? "\u0000").split("\u0000")
  const sort = useMemo(() => readSort(keys, { key, dir }, legacy), [keys, key, dir, legacy])
  return [
    sort,
    (next) =>
      void saveSettings({ [keyField]: next.key, [dirField]: next.dir }).catch(
        quietly("Saving the sort order"),
      ),
  ]
}
