import type { Profile, Room } from "./db.ts"
import { memberLabel } from "./room-log.ts"

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
