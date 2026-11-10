# A room lists in every bot it seats

ADR 0127 gave rooms a sidebar section of their own: after the list of chats or bots, one row per room,
ranked by the section's own order, with New room at its end. That was the honest reading while the
sidebar was the only place a list could be, and it made a room findable without knowing which list it
had sorted into. But a room is a conversation on one Host shared by several of that Host's bots, and
the screen a reader is on when they want it is a bot's — the bot that answers in it, whose other chats
are on the same list. A section apart from every bot made the room a place, and a room with several
members belonged to none of the screens its members live on.

**So a room is a row of every bot's chat list whose roster seats that bot.** The bot layout's sidebar
loses its Rooms section — with `ROOM_SORTS`, `useRoomSort`, `sortRooms` and `lib/room-order.ts` — and
the room draws among the chats, in the list's one order: pinned first, then by what was last said. Its
row wears its members' pictures where a chat wears its bot's (ADR 0126), and the sentence saying it
needs the reader, read off the page the room keeps (ADR 0120). New room stands on the list beside New
chat, where a conversation is started.

**A room is read by membership, not by the record's owner.** Its record is carried by one bot and
belongs in several lists, so which lists draw it is decided from its roster: `roomAnswerers` answers
the enabled bots this device holds for its members, in the order the Host seats them, and
`roomAnswerer` is that list's first entry — one rule decides both which bots draw the room and which
one speaks in it (ADR 0115). `chatOwner` then answers a row's owner the same way it answers a chat's,
so no screen keeps a second rule. A room whose every member is unlinked lists in no bot's list; it is
still the Host's, and it draws again when a member is linked.

**The pin is the device's, and it lifts the row.** A room's pin has never synced (ADR 0121), and a
pinned room stands at the top of a bot's list exactly as a pinned chat does — which means two devices
can order the same list differently for its rooms alone. That was true of the section, and the
alternative is a room's pin travelling through the bot that carried its record, which is a fact about
that bot rather than about the room.

**The legacy layout keeps its section.** Recents is the only list that layout has, it holds chats
alone, and a room is nobody's thread: without a section a room would be stranded, so it keeps one,
ranked by the same row order the chat list uses (`compareChatOrder`) and drawn even when it holds
nothing, since an empty room list is where someone who has never made one finds the control.

**What it supersedes.** [ADR 0127](0127-a-room-is-a-sidebar-section-of-its-own.md), on where a room is
drawn and how it is ordered. Its reading of a room stands: a room is a conversation, it opens at a
chat's address, and it is renamed, disbanded and pinned like one — which is exactly why it belongs
beside the chats rather than in a place of its own. Its rejection of "a Rooms destination above the
list" is the same argument this decision makes one step further.

## Considered options

- **A Rooms band inside a bot's list** — pinned rooms first, then chats. Two orderings in one list, and
  a row that moves when its own pin changes.
- **A room listed once, on the bot that carried its record.** That is the record's bookkeeping rather
  than the roster, and it would hide a room from the bots that answer in it.
- **Rooms in the bots' lists and the section kept as well.** Two places to find one room, one of them
  always stale.
- **Dropping the legacy layout's section too.** Recents would have nowhere to put a room, and a reader
  on that layout would lose every room they have.

## Consequences

- The same room draws in several lists. A reader who opens it from one bot and then from another is in
  one room, with one log.
- A room's pin and a chat's order can disagree across two devices, for rooms alone.
- `lib/room-order.ts` goes, and the section's sort menu with it; the legacy section ranks by the chat
  list's own rule.
- The room-lifecycle and room-waiting browser flows open a room from a bot's list rather than from the
  sidebar's section, and `docs/e2e-flow-audit.md` records the move.
