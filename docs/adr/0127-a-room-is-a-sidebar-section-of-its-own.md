# A room is a sidebar section of its own

Rooms used to be rows of whatever list the sidebar was showing: among Recents with the chats, and after
the bots in the bot-threads layout. That was the honest reading while rooms were few and the app only
read them — a room is nobody's thread, so it belonged to no bot's row, and nowhere else was there to put
it (ADR 0115, 0116). Starting one changed the arithmetic: the user makes rooms, keeps several, and wants
to find them without reading past the bots to do it.

**So the sidebar has a Rooms section, drawn after the list of chats or bots and before the footer.** It
reads the rooms the device lists, ranks them by its own order — recent, name, added, kept on this device
as every other list keeps its order (ADR 0091) — and lifts a pinned room to the top of the section
whatever the arrow says. The section draws even when it holds nothing: its last row is New room, and an
empty room list is where someone who has never made one finds the control.

**New room is that row**: the place the link-a-bot row used to hold at the end of the sidebar's list. A
room is started from the list of rooms, not from a footer button beside New chat, and there is one
control rather than two. Linking a bot is still on Settings' bot list, which is where a bot is described
and where the row already was.

**What follows, and is accepted.** Rooms leave Recents and the bot-threads list entirely: a pinned room
is pinned inside its own section, not lifted into the Pinned band that holds chats, so the two lists have
one ordering rule each rather than a shared one. The sidebar's rail draws the section's rows as icons with
New room among them, and hides the heading and the sort, as it hides every heading. And the section is
read from the device's own table (`useRoomNeeds`), not from a second read per room: a section that is
always drawn must not cost a Host call to draw empty.

## Considered and rejected

- **A Rooms destination above the list, beside Code and Canvas.** A room is a conversation: it opens at a
  chat's address, it is renamed, disbanded and pinned like one, and it belongs beside the chats rather
  than beside the tools.
- **Rooms as a band inside Recents.** That is what the app had, and it loses the one thing a section
  gives: a room is findable without knowing which list it was sorted into.
- **New room staying in the footer, with only the list moving.** Two controls that make a room is one
  more than the app needs, and the footer's button had no place of its own once rooms had a section.
