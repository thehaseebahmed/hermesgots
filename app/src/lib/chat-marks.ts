/**
 * A reader's own marks on a conversation — pinned, and archived — as the one writer of them: a pin
 * carries the clock its place in the pinned group is ordered by, and archiving takes the pin with it,
 * so no pin is left behind the Archived pill where no list could turn it off.
 *
 * A chat's and a run's marks go through `updateConversation`, which stamps `changedAt`, so the next
 * sync pass carries the mark to every device. A room's are the reader's rather than the Host's (ADR
 * 0121): its row's `changedAt` is the Host's clock and stays it, the marks are stamped in a field of
 * their own, and the pass that carries them is the bots' whose roster seats the room (ADR 0157). The
 * rules that read the marks — the cap and what its switch says — are `chat-list.ts`'s: this module
 * writes a mark, and answers the list one is counted over.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { chatRowOf, pinsOf, type ChatListRow } from "./chat-list"
import { readListedChats, seatedRoomRows } from "./chat-rows"
import { db, updateConversation, type Conversation, type Room } from "./db"
import { useRoomNeeds } from "./room"
import { seatingBots } from "./rooms"
import { syncChatsOf } from "./sync"

/**
 * Pins a conversation, or unpins it. The flag and the clock it is ordered by are one write: a pin
 * without a clock would land on top of every pin made before it, and a clock without its pin would
 * reorder the group the moment one was made.
 */
export async function setPinned(id: string, on: boolean) {
  const now = Date.now()
  // One pair of marks for either kind of row: a room is no different a row to mark, and `0` is only
  // ever the wire's way of saying "no pin", never this device's (`sync.ts` spells it there).
  const marks = on ? { pinned: true, pinnedAt: now } : { pinned: undefined, pinnedAt: undefined }
  const row = await db.conversations.get(id)
  const room = row?.room
  if (row && room) return markRoom(row, room, marks, now)
  await updateConversation(id, marks)
}

/**
 * Archives a conversation out of every list but the Archived pill, or brings it back. Archiving
 * clears the pin in the same write — a pin sitting behind the pill could not be unpinned from any
 * list, and the cap counts pins — while unarchiving leaves the row as unpinned as archiving made it.
 * A room takes both the same way.
 */
export async function setArchived(id: string, on: boolean) {
  const now = Date.now()
  const marks = on
    ? { archived: true, pinned: undefined, pinnedAt: undefined }
    : { archived: undefined }
  const row = await db.conversations.get(id)
  const room = row?.room
  if (row && room) return markRoom(row, room, marks, now)
  await updateConversation(id, marks)
}

/**
 * A room's marks, and the clock they were made at, written onto its row and carried to the Host.
 *
 * The write is `db.conversations.update` and not `updateConversation`: a room's `changedAt` is the
 * Host's own clock, and a reader's press in it would make the projection's idempotence check rewrite
 * the row on every read — and `useRoomNeeds` pull the room's log for a pin. `marksAt` is what a merge
 * compares instead, so a projection that left the Host before this press cannot undo it.
 *
 * The record goes to every bot whose roster seats the room, since any of a room's bots may carry it
 * (ADR 0115) and the mark has to read from every list that draws the room (ADR 0157). The pass is not
 * awaited: the mark is written, and reaching the Host must not hold the switch just turned.
 */
async function markRoom(
  row: Conversation,
  room: Room,
  marks: Pick<Conversation, "pinned" | "pinnedAt" | "archived">,
  marksAt: number,
) {
  await db.conversations.update(row.id, { ...marks, marksAt })
  const bots = new Map((await db.profiles.toArray()).map((bot) => [bot.id, bot]))
  const seated = seatingBots(room, row, bots).map((bot) => bot.id)
  if (seated.length) void syncChatsOf(seated)
}

/**
 * The pinned rows of one bot's list — the chats it holds, a routine's run among them, and the rooms
 * its roster seats — which is what the cap is counted over: a room and a run count toward the same
 * five as a chat. `undefined` until both reads have answered, and that answer is what a sheet reads a
 * switch by: a list read as empty would offer a sixth pin over one already holding five.
 */
export function usePinsInList(profileId: string): ChatListRow[] | undefined {
  const rooms = useRoomNeeds()
  const chats = useLiveQuery(async () => {
    const held = await readListedChats(profileId)
    // The record alone is enough: a row's marks are on it, and no tail is read for a count.
    return held.map((chat) => chatRowOf(chat))
  }, [profileId])
  if (!chats || !rooms) return undefined
  return pinsOf([...chats, ...seatedRoomRows(rooms, profileId)])
}
