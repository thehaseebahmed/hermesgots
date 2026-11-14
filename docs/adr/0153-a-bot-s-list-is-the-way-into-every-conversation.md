# A bot's list is the way into every conversation

**Supersedes in part [ADR 0144](0144-a-chat-is-the-root.md) and
[ADR 0145](0145-a-picked-chat-opens-as-the-apps-only-entry.md).**

[ADR 0136](0136-a-bots-screen-is-the-list-of-its-chats.md) made a bot's screen the list of its chats,
and opened it on the chat this device was last in there. [ADR 0144](0144-a-chat-is-the-root.md) made
the chat the root instead: a bot's address resumed the chat on a *replace*, so back from it was the
app's, and the way to the list became a control in the chat's own bar.
[ADR 0145](0145-a-picked-chat-opens-as-the-apps-only-entry.md) made a row picked from that list the
app's only entry. Both were about where a reader *lands*; neither asked what the bot's row in the
sidebar means. A bot's row is the way into the bot, and the bot is a list of conversations: a press
that sometimes draws that list and sometimes resumes a conversation has two meanings the row cannot
show. The reader who presses a bot to see what came in, and is put back into the chat they left, has
been answered a question they did not ask.

**A bot's address is its list.** No landing: `/b/<bot>` draws the chats every time, at the app's
entry, so the bot's row in the sidebar, Home, a reload of the address and a step back onto it all
land in the same place. The memory `lib/last-chat.ts` kept is deleted with it, along with the entry
state a stepped-back list read (`BACK_ON_LIST`, `backToList`) and the two fields the device dump took
from it: a value nothing acts on is a value that will drift. A bot with no chats draws an empty list.
A chat picked from the list is still the app's only entry — ADR 0145's move stands, and what a chat
opens is the app's root.

**The order is by what was received.** A row's clock is now the newest message the *bot* sent, not
the newest of any role: the list answers "what came in", and what the reader typed came from them.
The consequence is the one the rule implies — a chat the reader has just spoken in sits where the
bot's last word put it, saying that word — and it is why the row's line and its clock are now the same
reading rather than two. A room keeps its log's last activity and a routine's delivery its own time:
both are arrivals.

**A room and a run open beside the list too.** Everything a bot's list draws is a row of it, so
everything it draws opens in the pane beside it. A room's record names its Host rather than the bot
whose list it was picked from, so the list's own links say which bot they are for in `state.bot` and
that is read before the record's owner: the list the reader was looking at is the one that stays. A
project session and a canvas still answer to Code's and their own panes.

**The bot is named once.** Where the list stands beside a chat at 1024px or 1280px, its own bar
already carries the bot's face; the chat beside it drops its copy. One screen, one bot's face.

**A chat's bar holds its context and one press, and that press is its settings.** The list control ADR
0144 put in a chat's bar is gone: the list is where a conversation is reached from, and back — or the
sidebar — leaves it. The `…` a chat kept (ADR 0136 said "a chat keeps its `…`") is gone too: the press
the header's title answers opens an **Edit chat** sheet, a `Popup` holding the chat's name, typed in
the field it is shown in, its notifications as a switch in a card of their own, and its delete. A
project session keeps its `…`: resolve, discard and a session's delete are not a chat's settings, and
a bot's own mute and delete stay on the bot's settings page, where a bot is what is being changed.
The routines control stays in the list's bar: it is a screen a bot's list opens, not a conversation's
control.

The chat's context is the exception to a bar with no controls: the ring stands in a bot's chat at
every width, because the sheet is where a reader goes to change something and the use is what they
read while they write. The menu held it only below 768px, where the bar had no room for the ring; the
bar has room now that the menu is gone.

**A bot's row in the sidebar is the app's own row height.** It carried 56px and its own padding for
two lines of text; the two lines fit the 44px row the rest of the app uses, so the band reads as one
list rather than as one with a gap between bots.

## Considered options

- **The landing kept, and the sidebar's row meaning "resume".** It is what ADR 0144 argued for, and it
  answers the reader who always wants the same chat. It costs every reader who opens the bot to see
  what arrived, and it makes the one row in the sidebar that behaves unlike every other row.
- **A bot's edit sheet from the list's bar, holding the bot's mute and its delete.** The issue's own
  leads pointed there. It is a different conversation from the one the reader is in when they press a
  chat's title, and the controls it would take are already together on the bot's page, where changing
  the bot is the subject.
- **The list button kept for the reader who wants it back.** It was one tap from a phone's chat to the
  list, and the drawer is the same one tap; a control that only repeats a lane and a drawer is the
  control ADR 0144 added when the list had no other way in.
- **The order kept at the newest message of any role.** A chat the reader writes in rises to the top,
  which is what a chat app's reader may expect — and it puts a chat nobody has answered above one that
  answered them a minute ago.
- **A per-screen sort.** The rule lives in `lib/chat-list.ts` because the legacy layout's Rooms band
  ranks its rows by the same rule; a sort on the screen would drift from it.

## Consequences

- Every device keeps the `gots:last-chat:<bot>` keys it wrote; nothing reads them and nothing migrates
  them, since one stale entry per bot costs less than a sweep.
- On a phone, the way from a chat back to the list is the drawer (or back, where the chat was pushed).
  `docs/e2e-flow-audit.md` and the `bot-chats` flow say so.
- `scripts/test-bot-open.tsx` is rewritten around the address being the list, and
  `scripts/test-chat-settings.tsx` holds the sheet. The new `bot-list` flow walks the order, the two
  panes, the one face and the phone's way back.
- A room and a run opened beside the list are edited by their own screens' controls; the chat sheet is
  a chat's alone.
- `app/scripts/e2e/bot-chats.mjs` walks a stack the change leaves: a bot's row onto the list at rung
  0, a pick onto the chat at rung 0, and back onto the app's edge from it.
