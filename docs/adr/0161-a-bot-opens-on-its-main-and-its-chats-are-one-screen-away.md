# A bot opens on its Main, and its chats are one screen away

**Supersedes [ADR 0153](0153-a-bot-s-list-is-the-way-into-every-conversation.md),
[ADR 0154](0154-a-conversation-sits-one-step-off-its-bot-s-list.md),
[ADR 0144](0144-a-chat-is-the-root.md) and
[ADR 0145](0145-a-picked-chat-opens-as-the-apps-only-entry.md).**

Those four records argued about one question — where a reader *lands* when they press a bot — and each
answer made the list more important: ADR 0153 made a bot's address its list, ADR 0154 made every
conversation one step off that list, and both together made a bot a place you enter to choose. That is
right for an archive and wrong for a companion. A reader whose bot has one permanent conversation
(the Desktop's Bot Chat, now Gots's **Main**, ADR 0160) is asking that conversation about something;
being handed a menu of every conversation they have ever had is a question they did not ask.

**The decision: a bot's address opens on its Main, and its other conversations stand on a Side Chat
List one press away.** `/b/<bot>` is a doorway that lands on `/c/<main>` in the same entry, so back
from Main is the app rather than the doorway again. `/b/<bot>/sidechats` is the list. Home, the
sidebar's bot row and a launch all go to the bot's address, and nothing is remembered: which chat was
open, which row was marked, where the list was scrolled.

**The list is a screen, not the bot's address.** It leads back to Main and is pushed over it; a chat
picked from it is pushed over the list; so the rungs are Main, the list, the chat, and back walks them
in that order. A side chat opened cold at its own address — a notification, a shared link, a reload —
answers back with its bot's Side Chat List rather than leaving the app, and the list answers with
Main. Main answers with the app and its "swipe again to close" toast: nothing is behind it.

**Two panes draw the same two addresses.** At the split width the Side Chat List takes the lane and
Main or the picked chat the item lane, with the same addresses at every width and no "No chat
selected" state left in the new layout. The list keeps its own address; the width is a way of drawing
two screens, never a third one.

**The order is by when a chat last moved at all**, not by what the bot last said: a chat the reader has
just written in is the one they are in. The row still says the bot's words — the order and the line are
two readings, and a list that answered both from one clock would put the reader's own message on the
row. The flat layout keeps its received-clock order, which is the list that layout has always drawn.

**What a side chat is, is one rule.** A chat or a room that is neither Main nor a routine's run. The
rows, the subtitle's count and Main's control's badge read it, so the three cannot disagree; archiving
a side chat takes it out of all three and puts it under the Archived pill. Main is never offered a
rename, a pin, an archive or a delete, and its sheet is not offered at all: its title is a press onto
the bot's settings page, where the bot's own mute is the way to quiet it.

**Main's bar carries the list, and no context.** The `list-todo` control stands in the context ring's
place, badged when any side chat is unread, and is not drawn where the list already stands beside the
chat. Main mounts no usage sheet and no ring.

**Routine runs leave the chat lists.** A run is the routines page's row and a notification still opens
it; the routines control stays in the Side Chat List's trailing corner. The new layout's lists do not
draw a run among their rows, and its pills do not offer a Routines filter that would keep what the
screen has already left out.

## Considered options

- **A remembered chat per bot** (what ADR 0144 and ADR 0136 did in turn). It answers the reader who
  always wants the same conversation, and it means a bot's entry can land anywhere; the request gives
  up the memory with the landing.
- **The list as the bot's address**, with Main its first row (what the flat layout still draws). It
  keeps one address and one screen, and makes the bot's home a menu.
- **A side chat as the app's only entry**, the way ADR 0145 rooted a picked chat. It leaves the list
  behind the reader, so the press that means "back" leaves the app.
- **The list's leading control as a link to Main** rather than a press that steps. From Main's own
  control it would push a second copy of Main over the list it came from, and back would return to the
  list again. One move — `up()` — serves both the control and the platform's guard, so they cannot
  disagree.
- **Two clocks or one.** The received clock is what ADR 0153 argued for and what the flat list keeps;
  the new screen's list is an index of where the reader has been, so it takes the newest message of
  either role. Both readings ride the one tail read.
- **A hidden Main** under the flat layout. That layout's address is its list, so a Main it did not draw
  could not be reached at all — the reason it is drawn as one of the rows.
- **A per-chat mute for Main.** Its sheet is not offered, so the bot's settings page is the one way to
  quiet it; a surface of its own would be a new control, not this change.

## Consequences

- A cold side chat lands its bot's Side Chat List rather than the app, so the exit toast arrives one
  press later than it did from a chat.
- A bot whose Main this device does not hold draws its list where the bot's address stands and lands on
  Main the first time that answer arrives.
- `/b/<bot>` changes meaning for a bookmark that expected the list; every link inside the app goes
  through `bot-tabs.ts`, and the list keeps an address of its own.
- The two-pane width is no longer a place where a bot's list stands with nothing in the item lane; the
  flat layout keeps that state, which is why its address is its list.
- `scripts/test-main-navigation.tsx` holds the addresses, `test-side-chats.tsx` the screen,
  `test-bot-chats-pane.tsx` the panes and `test-back-press.tsx` the platform's guard;
  `scripts/e2e/side-chats.mjs` walks the rungs in a browser, because the entry a press stands on is the
  browser's own history.
