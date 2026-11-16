/**
 * A reader's own marks on a conversation — pinned, and archived — as the one writer of them: a pin
 * carries the clock its place in the pinned group is ordered by, and archiving takes the pin with it,
 * so no pin is left behind the Archived pill where no list could turn it off.
 *
 * A chat's and a run's marks go through `updateConversation`, which stamps `changedAt`, so the next
 * sync pass carries the mark to every device. Their archive is Hermes's own flag and not this app's
 * mark (ADR 0159): where the bot's plugin can write it, the press writes it on the Host too, so the
 * session leaves every Hermes surface as well. A room's are the reader's rather than the Host's (ADR
 * 0121): its row's `changedAt` is the Host's clock and stays it, the marks are stamped in a field of
 * their own, and the pass that carries them is the bots' whose roster seats the room (ADR 0157). The
 * rules that read the marks — the cap and what its switch says — are `chat-list.ts`'s: this module
 * writes a mark, counts the list before it writes one, and answers the list one is counted over.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { chatRowOf, PIN_LIMIT, pinsOf, type ChatListRow } from "./chat-list"
import { readListedChats, seatedRoomRows } from "./chat-rows"
import { hasServer, serverConfig } from "./connection"
import { db, updateConversation, type Conversation, type Room } from "./db"
import { hasPluginFeature, setSessionArchived } from "./hermes"
import { readRoomNeeds, useRoomNeeds, type RoomNeedsRow } from "./room"
import { seatingBots } from "./rooms"
import { syncChatsOf } from "./sync"

/**
 * Pins a conversation, or unpins it, and answers whether the write was made: `false` where a sixth pin
 * was refused, which is what lets a caller say so rather than leave a switch flipped over a mark
 * nothing wrote.
 *
 * The flag and the clock it is ordered by are one write: a pin without a clock would land on top of
 * every pin made before it, and a clock without its pin would reorder the group the moment one was
 * made. Unpinning is never refused — it is what makes room.
 *
 * The cap is held here and not only by the switch that offers it (`pinSwitchOf`): a switch is one way
 * in, and a pin written straight through this function — by a screen, a queue, or a caller this build
 * has not written yet — would spend a slot its list has not got. A chat and a run are drawn in the one
 * list their record names (`profileId`); a room is drawn in every list whose roster seats it, and the
 * same pin spends a slot in each of them, so every one of those lists must have room.
 */
export async function setPinned(id: string, on: boolean): Promise<boolean> {
  const now = Date.now()
  // One pair of marks for either kind of row: a room is no different a row to mark, and `0` is only
  // ever the wire's way of saying "no pin", never this device's (`sync.ts` spells it there).
  const marks = on ? { pinned: true, pinnedAt: now } : { pinned: undefined, pinnedAt: undefined }
  const row = await db.conversations.get(id)
  // A bot's Main is not the reader's to mark (G2): it stands where it stands on every surface, so the
  // press is refused here rather than only by the switch that offers it.
  if (row?.main) return false
  if (on && row && !(await hasRoomForPin(row))) return false
  const room = row?.room
  if (row && room) {
    await markRoom(row, room, marks, now)
    return true
  }
  await updateConversation(id, marks)
  return true
}

/**
 * Archives a conversation out of every list but the Archived pill, or brings it back. Archiving
 * clears the pin in the same write — a pin sitting behind the pill could not be unpinned from any
 * list, and the cap counts pins — while unarchiving leaves the row as unpinned as archiving made it.
 * A room takes both the same way.
 *
 * A chat's and a run's archive is Hermes's own (`sessions.archived`), not a mark this app owns
 * (ADR 0159): where the bot can be asked and its plugin advertises `session_archive`, the flag is
 * written on the Host too, so the session leaves `hermes sessions list`, `/resume` and the Desktop's
 * list as well. The row here is written first and either way — the press is drawn at once, and a
 * chat whose session has gone still reads as one the reader put away. A host that can't hold the
 * flag answers `host: false`, and this device's mark is all the archive there is, exactly as before.
 */
export async function setArchived(id: string, on: boolean) {
  const now = Date.now()
  const marks = on
    ? { archived: true, pinned: undefined, pinnedAt: undefined }
    : { archived: undefined }
  const row = await db.conversations.get(id)
  // Main is never put away, on any Host (G2): nothing is written on the row and nothing is asked of
  // the Host, so no press can leave a bot without the conversation its screen opens on.
  if (row?.main) return
  const room = row?.room
  if (row && room) return markRoom(row, room, marks, now)
  await updateConversation(id, marks)
  if (row) await writeSessionArchive(row, on)
}

/**
 * Hermes's archive flag for one chat's session, where the Host can be asked for it.
 *
 * Two gates, held here and not by the sheet: a bot this device can call at all (`hasServer`), and a
 * plugin new enough to write the flag — `session_archive` (ADR 0159). An older plugin stores the
 * record and nothing else, so asking it would be a request whose answer the app would ignore; a
 * failed ask is swallowed for the same reason, since the write above is already the reader's mark.
 */
async function writeSessionArchive(row: Conversation, on: boolean) {
  const bot = await db.profiles.get(row.profileId)
  if (!hasServer(bot)) return
  const config = serverConfig(bot)
  try {
    if (!(await hasPluginFeature(config, "session_archive"))) return
    await setSessionArchived(config, row.id, on)
  } catch {
    // Away, or a Host from before the route: the mark on the row above is what this device reads.
  }
}

/**
 * The lists one row is drawn in, by the bot whose list it is: a chat's and a run's is the one their
 * record names, and a room's are the bots whose roster seats it (ADR 0115) — resolved by
 * `seatingBots`, the one reading of a room's seats the app carries, so a count here and the sync pass
 * that carries the mark cannot disagree about which lists a room is in.
 */
async function listsOf(row: Conversation): Promise<string[]> {
  if (!row.room) return [row.profileId]
  const bots = new Map((await db.profiles.toArray()).map((bot) => [bot.id, bot]))
  return seatingBots(row.room, row, bots).map((bot) => bot.id)
}

/**
 * Whether every list that draws this row has room for one more pin. A list's pins are the chats it
 * draws and the rooms it seats — `chat-rows.ts` owns both halves — counted as the sheet's switch
 * counts them, an archived pin being no pin (`pinsOf`).
 *
 * The row's own pin is left out of the count: a pin already made is no sixth, so a list holding five
 * with this row among them still has room for the pin it has. A row drawn in no list at all — a room
 * whose every member is unlinked on this device — has no list to spend a pin in, and nothing refuses
 * it.
 */
async function hasRoomForPin(row: Conversation): Promise<boolean> {
  const lists = await listsOf(row)
  if (!lists.length) return true
  const rooms = await readRoomNeeds()
  for (const profileId of lists) if (!(await listHasRoom(rooms, profileId, row.id))) return false
  return true
}

/** One list's room for a pin, counted over the rows it draws with this row's own mark left out. */
async function listHasRoom(
  rooms: readonly RoomNeedsRow[],
  profileId: string,
  exceptId: string,
): Promise<boolean> {
  const chats = await readListedChats(profileId)
  // The record alone is enough: a row's marks are on it, and no tail is read for a count.
  const rows = [
    ...chats.map((chat) => chatRowOf(chat)),
    ...seatedRoomRows(rooms, profileId),
  ].filter((drawn) => drawn.id !== exceptId)
  return pinsOf(rows).length < PIN_LIMIT
}

/**
 * A room's marks, and the clock they were made at, written onto its row and carried to the Host.
 *
 * The write is `db.conversations.update` and not `updateConversation`: a room's `changedAt` is the
 * Host's own clock, and a reader's press in it would make the projection's idempotence check rewrite
 * the row on every read — and `useRoomNeeds` pull the room's log for a pin. `roomMarksAt` is what a
 * merge compares instead, so a projection that left the Host before this press cannot undo it.
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
  await db.conversations.update(row.id, { ...marks, roomMarksAt: marksAt })
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
