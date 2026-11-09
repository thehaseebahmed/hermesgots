import { serverConfig } from "./connection.ts"
import { createRoom, disbandRoom, renameRoom } from "./hermes.ts"
import { memberLabel } from "./room-log.ts"
import { randomId } from "./utils.ts"
import { writeRoomRow, type Profile, type Room, type RoomMember } from "./db.ts"

/**
 * One room's life, written where it is read: a room belongs to its Host, so a create, a rename and a
 * disband are the Host's own calls (ADR 0115, ADR 0122) and this is the one place the app makes them.
 *
 * Every write carries ids this app minted, once per attempt intent: the room's id, the rename's event
 * id, the disband's cancel id. The Host is idempotent on each, so a retry after a dropped answer is
 * the same room, the same rename and the same stop rather than a second one of any of them.
 */

/** A room the app is about to make: the name, and the seats the user picked, in the app's spelling. */
export interface NewRoom {
  roomId: string
  name: string
  members: RoomMember[]
}

/**
 * The seats a set of bots would make, one per bot: the member id this app minted for it, its handle
 * and the profile it answers under.
 *
 * The handle is the bot's profile name, because a profile name is already unique on its Host — the
 * rule the room's answerer and its pictures are resolved by (ADR 0115) — so the app owns no naming
 * policy the Host would have to repeat, and a reserved or colliding handle comes back in the Host's
 * own words (ADR 0124).
 */
export function roomSeats(bots: Profile[]): RoomMember[] {
  return bots.map((bot) => ({
    memberId: randomId(),
    profile: bot.hermesProfile ?? "",
    handle: bot.hermesProfile ?? "",
    displayName: bot.name,
  }))
}

/** The id a room is made under, minted once for one attempt so a retry is the same room. */
export function newRoomId(): string {
  return randomId()
}

/** A room made on its Host, and its row written from the record the Host answered. */
export async function startRoom(bot: Profile, room: NewRoom): Promise<void> {
  const config = serverConfig(bot)
  if (!config) throw new Error("This bot has no address to make a room on.")
  const record = await createRoom(config, room)
  await writeRoomRow(room.roomId, record, bot.id)
}

/** A room renamed on its Host: the row takes the Host's own name when its record lands. */
export async function renameRoomTo(bot: Profile, roomId: string, name: string): Promise<void> {
  const config = serverConfig(bot)
  if (!config) throw new Error("This bot has no address to rename its room on.")
  const record = await renameRoom(config, roomId, { eventId: randomId(), name })
  await writeRoomRow(roomId, record, bot.id)
}

/** A room ended on its Host: the row and its page of the log go as the Host's own deletion. */
export async function disbandRoomNow(bot: Profile, roomId: string): Promise<void> {
  const config = serverConfig(bot)
  if (!config) throw new Error("This bot has no address to disband its room on.")
  const record = await disbandRoom(config, roomId, randomId())
  await writeRoomRow(roomId, record, bot.id)
}


/**
 * The bot that answers for a room: the first of its members this device has a bot for, turned on.
 *
 * A room belongs to its Host, so no bot owns it. The roster is the only thing that says which of the
 * Host's bots may answer in it, and every reader resolves the answerer from there rather than from
 * the bot that carried the record here (ADR 0115). A member this device holds no bot for is skipped —
 * the room still draws it, but nothing here can reach it — so a room whose every member is unlinked
 * has no answerer, and still lists.
 * `host` is the Host the record came from, where this device still holds the bot that carried it: a
 * profile name is unique on its Host and not across the device's bots, so a room on one server never
 * answers with another server's bot of the same name.
 */
export function roomAnswerer(
  room: Room,
  bots?: Map<string, Profile>,
  host?: string,
): Profile | undefined {
  if (!bots?.size) return undefined
  const seated = botsByProfile(bots.values(), host)
  for (const member of room.members) {
    const bot = member.profile ? seated.get(member.profile) : undefined
    // A member turned off in Gots answers nothing, while the room still lists and still draws it.
    if (bot && !bot.disabled) return bot
  }
  return undefined
}

/** A room's members as its row names them: what each is called, in the order the Host seats them. */
export function roomMembersLine(room: Room): string {
  return room.members.map(memberLabel).filter(Boolean).join(", ")
}

/**
 * The one sentence a room that needs the user says, wherever it is drawn: its row in the chat list,
 * and the room's own screen under the transcript. The member's name where the log names one, and
 * the room's own words where it doesn't.
 */
export function needsYouLine(name?: string): string {
  return name ? `${name} needs you — reply in the room.` : "The room needs you — reply."
}

/**
 * The bots this device holds, by the Hermes profile each one is: a room's member is a profile, so
 * its bubble's picture comes from the bot seated there, and a member with no bot here draws as its
 * name alone. `host` is the Host the room came on, because a profile name is unique on its Host and
 * not across a device's bots — the one rule the answerer and the pictures both read (ADR 0115).
 * The first bot of a profile keeps the seat.
 */
export function botsByProfile(bots: Iterable<Profile>, host?: string): Map<string, Profile> {
  const seated = new Map<string, Profile>()
  for (const bot of bots) {
    if (!bot.hermesProfile || seated.has(bot.hermesProfile)) continue
    if (host && bot.hostId !== host) continue
    seated.set(bot.hermesProfile, bot)
  }
  return seated
}
