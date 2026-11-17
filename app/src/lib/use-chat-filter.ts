/**
 * The pill one bot's list keeps on this device, narrowed to the pills the screen drawing it holds.
 *
 * The stored key is read as the key itself rather than the settings row, since a live query answering
 * a fresh object would re-render the list on every sync write (the reason `useStoredSort` records).
 * A key the screen has not got — the flat list's Routines, on the side list — reads as All, so a
 * device that turns the switch on and off cannot land on a pill its layout does not draw.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { isChatFilter, type ChatFilter } from "@/lib/chat-list"
import { chatFilterOf } from "@/lib/db"

export function useChatFilter(
  profileId: string,
  pills: readonly { key: ChatFilter }[],
): ChatFilter {
  const kept = useLiveQuery(async () => (await chatFilterOf(profileId)) ?? null, [profileId])
  return isChatFilter(kept) && pills.some((pill) => pill.key === kept) ? kept : "all"
}
