/**
 * A reader's own marks on a conversation — pinned, and archived — as the one writer of them: a pin
 * carries the clock its place in the pinned group is ordered by, and archiving takes the pin with it,
 * so no pin is left behind the Archived pill where no list could turn it off.
 *
 * Both writes go through `updateConversation`, which stamps `changedAt`, so the next sync pass carries
 * the mark to every device. The rules that read the marks — the cap and what its switch says — are
 * `chat-list.ts`'s: this module writes a mark, and answers the list one is counted over.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { chatRowOf, pinsOf, type ChatListRow } from "./chat-list"
import { readBotChats } from "./chat-rows"
import { updateConversation } from "./db"
import { useRoomNeeds } from "./room"
import { roomRowOf } from "./rooms"

/**
 * Pins a conversation, or unpins it. The flag and the clock it is ordered by are one write: a pin
 * without a clock would land on top of every pin made before it, and a clock without its pin would
 * reorder the group the moment one was made.
 */
export async function setPinned(id: string, on: boolean) {
  await updateConversation(
    id,
    on ? { pinned: true, pinnedAt: Date.now() } : { pinned: undefined, pinnedAt: undefined },
  )
}

/**
 * Archives a conversation out of every list but the Archived pill, or brings it back. Archiving
 * clears the pin in the same write — a pin sitting behind the pill could not be unpinned from any
 * list, and the cap counts pins — while unarchiving leaves the row as unpinned as archiving made it.
 */
export async function setArchived(id: string, on: boolean) {
  await updateConversation(
    id,
    on
      ? { archived: true, pinned: undefined, pinnedAt: undefined }
      : { archived: undefined },
  )
}

/**
 * The pinned rows of one bot's list — the chats it holds, a routine's run among them, and the rooms
 * its roster seats — which is what the cap is counted over: a room and a run count toward the same
 * five as a chat. `undefined` until both reads have answered, so a sheet never reads a list as empty
 * and offers a sixth pin; the rows carry the marks, and nothing here filters them.
 */
export function usePinsInList(profileId: string): ChatListRow[] | undefined {
  const rooms = useRoomNeeds()
  const chats = useLiveQuery(async () => {
    const held = await readBotChats(profileId)
    // The record alone is enough: a row's marks are on it, and no tail is read for a count.
    return held.map((chat) => chatRowOf(chat))
  }, [profileId])
  if (!chats || !rooms) return undefined
  const seated = rooms
    .filter((room) => room.seated.includes(profileId))
    .map((room) => roomRowOf(room.chat, room.faces, room.said))
  return pinsOf([...chats, ...seated])
}
