/**
 * The sidebar's Rooms section: how it ranks what a room's row says (ADR 0127), kept on this device the
 * way every other sortable list keeps its order (ADR 0091).
 *
 * A room ranks by the same three facts a chat does — when it last moved, its name, when it was made —
 * because it is drawn by the same row and read the same way. Pin is not one of them: a pinned room is
 * lifted to the top of the section by the list itself, so the arrow never hides a pin.
 */
import type { RoomSort } from "./db.ts"
import type { RoomNeedsRow } from "./room.ts"
import { useStoredSort } from "./use-sort.ts"
import { withDir, type Sort, type SortKey } from "./sort.ts"

/** The keys the Rooms section ranks by, each with the way it reads best. */
export const ROOM_SORTS: readonly SortKey<RoomSort>[] = [
  { key: "recent", label: "Recent", dir: "desc" },
  { key: "name", label: "Name", dir: "asc" },
  { key: "added", label: "Added", dir: "asc" },
]

/** The Rooms section's order, kept on this device. */
export function useRoomSort(): [Sort<RoomSort>, (sort: Sort<RoomSort>) => void] {
  return useStoredSort(ROOM_SORTS, ["roomSort", "roomSortDir"])
}

/**
 * A room's rows in the section's order, with its pins first: a pinned room stays where the user put it
 * whatever the arrow says, and the arrow orders what is left. Each key falls back to the newest first,
 * then to the name, so two rooms that tie read the same way on every device.
 */
export function sortRooms(rows: RoomNeedsRow[], sort: Sort<RoomSort>): RoomNeedsRow[] {
  // Every comparator reads the way `asc` should: oldest first, A to Z, first made first. The arrow
  // the user picked is what turns it round (ADR 0091), so `recent` with `desc` is newest first.
  const byRecent = (one: RoomNeedsRow, two: RoomNeedsRow) => one.chat.updatedAt - two.chat.updatedAt
  const byName = (one: RoomNeedsRow, two: RoomNeedsRow) =>
    one.chat.title.localeCompare(two.chat.title) || byRecent(one, two)
  const byAdded = (one: RoomNeedsRow, two: RoomNeedsRow) =>
    (one.chat.createdAt ?? one.chat.updatedAt) - (two.chat.createdAt ?? two.chat.updatedAt) ||
    byRecent(one, two)
  const compare =
    sort.key === "name" ? byName : sort.key === "added" ? byAdded : byRecent
  const ordered = [...rows].sort((one, two) => withDir(compare(one, two), sort.dir))
  return [
    ...ordered.filter((one) => one.chat.pinned),
    ...ordered.filter((one) => !one.chat.pinned),
  ]
}
