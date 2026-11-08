import type { Profile, Room, RoomMember } from "./db.ts"

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
  const seated = new Map<string, Profile>()
  for (const bot of bots.values()) {
    if (bot.disabled || !bot.hermesProfile) continue
    if (host && bot.hostId !== host) continue
    if (!seated.has(bot.hermesProfile)) seated.set(bot.hermesProfile, bot)
  }
  for (const member of room.members) {
    const bot = member.profile ? seated.get(member.profile) : undefined
    if (bot) return bot
  }
  return undefined
}

/** A room's members as its row names them: what each is called, in the order the Host seats them. */
export function roomMembersLine(room: Room): string {
  return room.members
    .map(memberName)
    .filter(Boolean)
    .join(", ")
}

function memberName(member: RoomMember): string {
  return member.displayName || member.handle || member.profile || ""
}
