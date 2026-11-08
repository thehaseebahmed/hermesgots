import type { RoomAttachment, RoomEvent, RoomMember } from "./db.ts"

export type { RoomEvent }

/**
 * A room's log, folded into what its screen draws (ADR 0116).
 *
 * The Host orders a room's events by one sequence number and writes them under one authority, so
 * the fold is a sort and a reading — never a merge: two devices that read the same page draw the
 * same transcript. A room draws a conversation and not a session (Q7): a member's reply is a bubble
 * with its name, and a turn's own rows are either silence or one line saying what happened, since
 * there are no tool rows and no thinking rows in a room.
 *
 * Import-free, so `scripts/test-room-log.mjs` runs it as a pure rule.
 */

/** A row a room screen draws: the user's message, a member's reply, or one line of notice. */
export interface RoomRow {
  seq: number
  kind: "user" | "member" | "notice"
  text: string
  /** The Host's own id for the message, which its files' addresses are signed over. */
  eventId: string
  memberId?: string
  name?: string
  /** The files the message carried: drawn above the words, and enough on their own to draw a row. */
  attachments?: RoomAttachment[]
}

/**
 * What each notice says, in the app's words where the Host's kind is not already a sentence.
 *
 * Only a kind that happened *to the conversation* is drawn: a round that settled, a turn that
 * started or a member that passed is silence (the plan's Q7 — a room is a conversation, not a
 * session), and a `room.activity` that settled says nothing either. What is left is what the user
 * would otherwise have to guess: a member that could not answer, a turn that failed or was
 * cancelled, and a round the Host bounded.
 */
const NOTICES: Record<string, string> = {
  "member.unavailable": "A member couldn't answer.",
  // A member whose turn could not be placed — unseated, unreachable, out of budget — is deferred
  // with its reason, which is the Host's word for "this one did not get to answer".
  "turn.deferred": "A member couldn't answer.",
  "turn.failed": "A member's turn failed.",
  "turn.cancelled": "A member's turn was stopped.",
  "room.activity": "The room stopped.",
  "room.stop_requested": "The room was stopped.",
  "room.disbanded": "This room was disbanded.",
}

/** The two bounds the Host reports (`room.activity`'s own reasons), each in the app's words. */
const BOUNDED: Record<string, string> = {
  max_rounds: "The room stopped at its round limit.",
  max_messages: "The room stopped at its message limit.",
}

/**
 * The room's rows, in the Host's order: what a reader sees of everything that has happened in it.
 *
 * A row with nothing to draw is dropped rather than drawn empty — a notice the Host wrote for a
 * `room.activity` that settled, a reply whose text the Host trimmed — but a message's files are
 * something to draw on their own: a room's photo or PDF is sent with no words at all, and a row
 * whose text is empty is still the message that carried them. A row names its member by the label
 * the log carries, falling back to the roster the caller passes for a row written before a roster
 * change or by a gateway that names none, and every row keeps the Host's own event id — the fold is
 * over the Host's log, where a row always has one, and a file's address is signed over it.
 */
export function foldRoom(events: RoomEvent[], members: RoomMember[] = []): RoomRow[] {
  const seen = new Set<number>()
  const rows: RoomRow[] = []
  for (const event of [...events].sort((one, two) => one.seq - two.seq)) {
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    const files = event.attachments?.length ? { attachments: event.attachments } : {}
    if (event.kind === "message.user") {
      const text = event.text ?? ""
      if (text.trim() || event.attachments?.length)
        rows.push({ seq: event.seq, kind: "user", text, eventId: event.eventId, ...files })
      continue
    }
    if (event.kind === "message.member") {
      const text = event.text ?? ""
      if (!text.trim() && !event.attachments?.length) continue
      const name = event.name || memberName(members, event.memberId)
      rows.push({
        seq: event.seq,
        kind: "member",
        text,
        eventId: event.eventId,
        ...(event.memberId ? { memberId: event.memberId } : {}),
        ...(name ? { name } : {}),
        ...files,
      })
      continue
    }
    const words = noticeOf(event)
    if (words) rows.push({ seq: event.seq, kind: "notice", text: words, eventId: event.eventId })
  }
  return rows
}

/** One notice's words, where the Host's own kind is one: its error when it gave a sentence. */
function noticeOf(event: RoomEvent): string | undefined {
  if (event.kind === "room.activity") {
    if (event.status !== "bounded") return undefined
    return (event.reason && BOUNDED[event.reason]) || NOTICES["room.activity"]
  }
  const told = NOTICES[event.kind]
  if (!told) return undefined
  return event.error ? `${told} ${event.error}` : told
}

/**
 * What a room calls one of its members: the name it seats them under, its handle where the Host
 * named none, and the profile it is. One rule, because the header's roster, a reply's bubble and
 * the who-is-working line all name the same people.
 */
export function memberLabel(member: RoomMember): string {
  return member.displayName || member.handle || member.profile || member.memberId || ""
}

/** The seated member a row belongs to, by its id, and nothing where the roster no longer holds it. */
export function memberOf(members: RoomMember[], memberId?: string): RoomMember | undefined {
  return memberId ? members.find((member) => member.memberId === memberId) : undefined
}

/** The user's own handle at the end of a member's words, as a mention rather than a name's start. */
const MENTION = /@user\b/i

/**
 * The member whose reply ended addressed to the user — `@user` — and nothing while the room isn't
 * asking for them.
 *
 * An `@user` escalation is the Host settling a round with no peer cited, so it is a reading of the
 * log and never a call (the plan's own decision). The last thing said decides: a reply addressed to
 * the user asks, the user answering answers it, and a member's later reply says the round moved on.
 * A handle that merely begins with `@user` is somebody's name, not the user, so the mention ends on
 * a word boundary.
 */
export function askingMember(
  events: RoomEvent[],
  members: RoomMember[] = [],
): { memberId?: string; name?: string } | undefined {
  const asked = askingEvent(events, members)
  return asked
    ? {
        ...(asked.memberId ? { memberId: asked.memberId } : {}),
        ...(asked.name ? { name: asked.name } : {}),
      }
    : undefined
}

/**
 * The reply that ends addressed to the user, with the sequence it sits at: the row that asks, which
 * is what the chat list's needs-you mark is measured from. The room's screen names the member and
 * the list compares the sequence with the newest one this device has drawn.
 */
export function askingEvent(
  events: RoomEvent[],
  members: RoomMember[] = [],
): { seq: number; memberId?: string; name?: string } | undefined {
  const seen = new Set<number>()
  let asking: { seq: number; memberId?: string; name?: string } | undefined
  for (const event of [...events].sort((one, two) => one.seq - two.seq)) {
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    if (event.kind === "message.user") {
      asking = undefined
      continue
    }
    if (event.kind !== "message.member") continue
    const addressed = MENTION.test(event.text ?? "")
    const name = event.name || memberName(members, event.memberId)
    asking = addressed
      ? {
          seq: event.seq,
          ...(event.memberId ? { memberId: event.memberId } : {}),
          ...(name ? { name } : {}),
        }
      : undefined
  }
  return asking
}

/** A member's name, by id: its label where the roster seats it. */
export function memberName(members: RoomMember[], memberId?: string): string | undefined {
  const seated = memberOf(members, memberId)
  return seated ? memberLabel(seated) || undefined : undefined
}

/** The newest sequence the log holds: what a device has drawn, and where its next read starts. */
export function newestSeq(events: { seq: number }[]): number {
  return events.reduce((newest, event) => (event.seq > newest ? event.seq : newest), 0)
}

/**
 * The members the Host has at work, in its own admission order: only the phases that are work, so a
 * member queued behind another is drawn apart from the one answering now. Only `member_activity` is
 * read — a room between rounds says nobody is working, which is true: its work is the live tasks and
 * nothing else.
 */
export function workingMembers(
  members: RoomMember[],
  activity: { memberId: string; status: string }[] = [],
): RoomMember[] {
  return phase(members, activity, (status) => status !== "queued")
}

/** The members the Host has queued behind the ones at work, in the same order. */
export function queuedMembers(
  members: RoomMember[],
  activity: { memberId: string; status: string }[] = [],
): RoomMember[] {
  return phase(members, activity, (status) => status === "queued")
}

function phase(
  members: RoomMember[],
  activity: { memberId: string; status: string }[],
  keep: (status: string) => boolean,
): RoomMember[] {
  const seated = new Map(members.map((member) => [member.memberId, member]))
  const found: RoomMember[] = []
  const seen = new Set<string>()
  for (const one of activity) {
    const member = seated.get(one.memberId)
    if (!member || seen.has(one.memberId) || !keep(one.status)) continue
    seen.add(one.memberId)
    found.push(member)
  }
  return found
}

/**
 * The who-is-working line: the members now answering, named, or the ones queued where none has
 * started, or the room itself answering where its Host reports work but names no member (an older
 * gateway, or a state read that lands between two turns). The line is the room's, so it says who —
 * or, failing that, that the room is at work — and never what: the Host names the member, not the
 * tool it ran.
 */
export function workingLine(
  working: RoomMember[],
  queued: RoomMember[] = [],
  roomWorking = false,
): string | undefined {
  const names = (members: RoomMember[]) => members.map(memberLabel).filter(Boolean)
  if (names(working).length) return line(names(working), "working")
  if (names(queued).length) return line(names(queued), "next")
  return roomWorking ? "The room is answering…" : undefined
}

function line(names: string[], doing: string): string {
  if (names.length === 1) return `${names[0]} is ${doing}…`
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are ${doing}…`
}
