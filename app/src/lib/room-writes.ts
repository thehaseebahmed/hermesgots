
/**
 * A room's life, written where it is read: a room belongs to its Host, so a create, a rename and a
 * disband are the Host's own calls (ADR 0115, ADR 0122) and this is the one place the app makes them.
 *
 * Every write carries ids this app minted, once per attempt intent: the room's id, the rename's event
 * id, the disband's cancel id. The Host is idempotent on each, so a retry after a dropped answer is
 * the same room, the same rename and the same stop rather than a second one of any of them.
 *
 * It sits beside the room model rather than in it: the model is read by the node tests that have no
 * bundler's aliases (`test-chat-owner.mjs` loads it through `chat-owner.ts`), and the one thing these
 * writes need is the client, which speaks them.
 */
import { serverConfig } from "./connection.ts"
import { createRoom, disbandRoom, renameRoom, type RoomCreate } from "./hermes.ts"
import { writeRoomRow, type Profile } from "./db.ts"

/** A room made on its Host, and its row written from the record the Host answered. */
export async function startRoom(bot: Profile, room: RoomCreate): Promise<void> {
  const config = serverConfig(bot)
  if (!config) throw new Error("This bot has no address to make a room on.")
  const record = await createRoom(config, room)
  await writeRoomRow(room.roomId, record, bot.id)
}

/** A room renamed on its Host: the row takes the Host's own name when its record lands. */
export async function renameRoomTo(
  bot: Profile,
  roomId: string,
  name: string,
  eventId: string,
): Promise<void> {
  const config = serverConfig(bot)
  if (!config) throw new Error("This bot has no address to rename its room on.")
  const record = await renameRoom(config, roomId, { eventId, name })
  await writeRoomRow(roomId, record, bot.id)
}

/** A room ended on its Host: the row and its page of the log go as the Host's own deletion. */
export async function disbandRoomNow(
  bot: Profile,
  roomId: string,
  cancelId: string,
): Promise<void> {
  const config = serverConfig(bot)
  if (!config) throw new Error("This bot has no address to disband its room on.")
  const record = await disbandRoom(config, roomId, cancelId)
  await writeRoomRow(roomId, record, bot.id)
}
