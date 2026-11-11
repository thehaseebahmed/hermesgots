import { hostKey } from "./connection.ts"
import { memberLabel } from "./room-log.ts"
import { randomId } from "./utils.ts"
import { NO_ROOM_MESSAGES, plainLine } from "./words.ts"
import type { ChatListRow } from "./chat-list.ts"
import type { Conversation, Profile, Room, RoomEvent, RoomMember } from "./db.ts"

/**
 * The seats a set of bots would make, one per bot: the member id this app minted for it, its handle
 * and the profile it answers under.
 *
 * The handle is the bot's profile name, because a profile name is already unique on its Host — the
 * rule the room's answerer and its pictures are resolved by (ADR 0115) — so the app owns no naming
 * policy the Host would have to repeat, and a reserved or colliding handle comes back in the Host's
 * own words (ADR 0129).
 */
export function roomSeats(bots: Profile[]): RoomMember[] {
  return bots.map((bot) => ({
    memberId: randomId(),
    profile: bot.hermesProfile ?? "",
    handle: bot.hermesProfile ?? "",
    displayName: bot.name,
  }))
}

/**
 * The bots a room lists for: every member this device has a bot for, turned on, in the order the
 * Host seats them — which is the order its row's faces are drawn in.
 *
 * A room belongs to its Host, so no bot owns it. The roster is the only thing that says which of the
 * Host's bots may answer in it, and every reader resolves the answerers from there rather than from
 * the bot that carried the record here (ADR 0115). A member this device holds no bot for is skipped —
 * the room still draws it, but nothing here can reach it — so a room whose every member is unlinked
 * has no answerer and lists in no bot's list.
 * `anchor` is the bot that carried the record here, which is the Host the room answers on: a profile
 * name is unique on its Host and not across the device's bots, so a room on one server never answers
 * with another server's bot of the same name.
 */
export function roomAnswerers(
  room: Room,
  bots?: Map<string, Profile>,
  anchor?: { baseUrl: string } | null,
): Profile[] {
  if (!bots?.size) return []
  const seated = botsByProfile(bots.values(), anchor)
  const answerers: Profile[] = []
  for (const member of room.members) {
    const bot = member.profile ? seated.get(member.profile) : undefined
    // A member turned off in Gots answers nothing, while the room still lists and still draws it.
    if (bot && !bot.disabled) answerers.push(bot)
  }
  return answerers
}

/**
 * The bot that answers for a room: the first of the bots it lists for, so one rule decides both
 * which bots draw the room and which one speaks in it (ADR 0115).
 */
export function roomAnswerer(
  room: Room,
  bots?: Map<string, Profile>,
  anchor?: { baseUrl: string } | null,
): Profile | undefined {
  return roomAnswerers(room, bots, anchor)[0]
}

/** How many pictures a room's row holds before it counts the rest. */
export const FACES = 4

/**
 * The pictures a room's row draws: one per member whose bot this device holds, up to four, and how
 * many members the row could not show.
 *
 * A row is one line tall, so the cluster is bounded rather than scrolled: four faces at a 20px size
 * with an 8px overlap, and a `+N` for the rest (ADR 0126). A member whose bot this device does not
 * hold has no picture to draw — it is still counted, so a room of two shows nothing extra for a
 * member that happens to be unlinked here.
 */
export function roomFaces(
  room: Room,
  bots: Iterable<Profile>,
  anchor?: { baseUrl: string } | null,
): { shown: string[]; more: number } {
  const seated = botsByProfile(bots, anchor)
  const shown: string[] = []
  for (const member of room.members) {
    if (shown.length === FACES) break
    const bot = member.profile ? seated.get(member.profile) : undefined
    if (bot?.botId) shown.push(bot.botId)
  }
  return { shown, more: Math.max(0, room.members.length - shown.length) }
}

/** A room's members as its row names them: what each is called, in the order the Host seats them. */
export function roomMembersLine(room: Room): string {
  return room.members.map(memberLabel).filter(Boolean).join(", ")
}

/**
 * The last message received in a room: the newest member's words on the page this device holds, on one
 * line, and nothing until a member has said anything.
 *
 * A room's words live on its Host and nothing of its transcript syncs (ADR 0116), so what a row can say
 * is what this device has already read of the log — the same page the room's own screen draws. The
 * user's own message is not the room's news, any more than it is in a chat: a chat's row says what the
 * bot last said, and a room's says what a member last did.
 */
export function roomLastLine(events: readonly Pick<RoomEvent, "seq" | "kind" | "text">[]) {
  let newest: Pick<RoomEvent, "seq" | "kind" | "text"> | undefined
  for (const event of events) {
    if (event.kind !== "message.member") continue
    if (!newest || event.seq > newest.seq) newest = event
  }
  return newest ? plainLine(newest.text ?? "") : undefined
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
 * What a room's row says it needs the user for: the member whose reply ended addressed to them, and
 * nothing once this device has drawn that reply.
 *
 * It is a reading of the page the room keeps — `roomNeeds` is what the log this device holds ends
 * asking for, `roomSeenSeq` what it has shown — so a room nobody has opened still says it, and
 * opening the room is the move that clears the mark.
 */
export function roomNeedsOf(
  chat: Pick<Conversation, "roomNeeds" | "roomSeenSeq">,
): string | undefined {
  const asked = chat.roomNeeds
  if (!asked?.seq || asked.seq <= (chat.roomSeenSeq ?? 0)) return undefined
  return needsYouLine(asked.name)
}

/**
 * A room's row in a list: its name, the last message received in it and the pictures it wears, and the
 * sentence its log ends asking the reader for.
 *
 * It is aged and ordered by the record's own clock, because a room's words live on its Host and
 * nothing of its transcript syncs (ADR 0116), and its pin is this device's (ADR 0121) — so a room
 * takes its place among the chats by the same rule every other row does.
 *
 * `faces` is what the list that draws it read for the room (`roomFaces`, off the same roster), and
 * `said` the last message received in it (`roomLastLine`, off the page this device holds), so a screen
 * with the row already in hand draws it without resolving either twice. A room nothing has been said
 * in yet names its members instead, which is the little it can honestly say.
 */
export function roomRowOf(
  chat: Pick<
    Conversation,
    "id" | "title" | "pinned" | "updatedAt" | "room" | "roomNeeds" | "roomSeenSeq"
  >,
  faces: { shown: string[]; more: number },
  said?: string,
): ChatListRow {
  const members = chat.room ? roomMembersLine(chat.room) : undefined
  return {
    id: chat.id,
    title: chat.title,
    line: said ?? members ?? NO_ROOM_MESSAGES,
    at: chat.updatedAt,
    pinned: Boolean(chat.pinned),
    // A room's need is `needs`, drawn as its line in the warning tone: a room is never a chat whose
    // reply is waiting, so it never wears the badge that says one is. The members ride the pictures,
    // which is the only place left that can name them once the line says what was said.
    room: { ...faces, ...(members ? { names: members } : {}) },
    needs: roomNeedsOf(chat),
  }
}

/**
 * The bots this device holds, by the Hermes profile each one is: a room's member is a profile, so
 * its bubble's picture comes from the bot seated there, and a member with no bot here draws as its
 * name alone. `anchor` is a bot of the Host the room came on, because a profile name is unique on its
 * Host and not across a device's bots — the one rule the answerer and the pictures both read (ADR
 * 0115), held to the address a bot answers at so two links of one gateway still resolve each other.
 * The first bot of a profile keeps the seat.
 */
export function botsByProfile(
  bots: Iterable<Profile>,
  anchor?: { baseUrl: string } | null,
): Map<string, Profile> {
  const seated = new Map<string, Profile>()
  const host = anchor ? hostKey(anchor) : null
  for (const bot of bots) {
    if (!bot.hermesProfile || seated.has(bot.hermesProfile)) continue
    if (host && hostKey(bot) !== host) continue
    seated.set(bot.hermesProfile, bot)
  }
  return seated
}
