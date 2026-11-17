import { useLiveQuery } from "dexie-react-hooks"

import { db } from "@/lib/db"
import { markersOf, type RoutineMarker } from "@/lib/routine-marker"

/** The id prefix every routine record carries (`ROW_PREFIX` in the plugin's `platform_gots.py`). */
export const ROUTINE_ID_PREFIX = "routine-"

/** No markers, as the same value on every render. */
const NONE: RoutineMarker[] = []

/**
 * The routine markers one bot's Main draws, read live and oldest first. A range of the primary key —
 * the prefix every routine record's id carries — rather than a scan of the bot's chats, since the
 * query re-runs on every write a streaming reply makes. Asked only where `enabled`, so a chat that
 * isn't a Main reads nothing.
 */
export function useRoutineMarkers(
  profileId: string | undefined,
  enabled: boolean,
): RoutineMarker[] {
  return (
    useLiveQuery(async () => {
      if (!enabled || !profileId) return NONE
      const rows = await db.conversations
        .where("id")
        .startsWith(ROUTINE_ID_PREFIX)
        .filter((chat) => chat.profileId === profileId)
        .toArray()
      return markersOf(rows)
    }, [profileId, enabled]) ?? NONE
  )
}

/**
 * When a bot's newest routine marker landed, or 0 where it has none: what moves its Main's activity,
 * so a run that came back while nobody was reading leaves Main unread until it is next opened.
 */
export async function newestMarkerAt(profileId: string): Promise<number> {
  const rows = await db.conversations
    .where("id")
    .startsWith(ROUTINE_ID_PREFIX)
    .filter((chat) => chat.profileId === profileId && Boolean(chat.routine))
    .toArray()
  return rows.reduce((newest, chat) => Math.max(newest, chat.updatedAt), 0)
}
