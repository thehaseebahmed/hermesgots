# A bot's screen is the list of its chats

A bot's screen was its **Main** — one permanent chat — with every other chat drawn inside it as a
card, a thread lane beside it, and a triage model deciding which of Main's messages left for one. A
bot that has been talking for a year therefore kept its own history in a list *inside* a chat, opened
on the last thing said rather than on the last thing the reader had open, and reached an older
conversation by scrolling Main far enough to find its card. A phone's messaging apps solved that
years ago: the screen is the list. So a bot's screen is a flat list of its chats, opened on the chat
this device was last in there.

**One list, one order, one row.** `/b/<profileId>` draws the bot's picture and its name (a button to
its Bot Settings) over a search field and a flat band of rows — pinned chats first, then by what was
last said, ties by id so two devices agree (`lib/chat-list.ts`, `orderChatRows`). A row carries an
icon, its title, the last message the reader was *told* — the bot's newest words, and their own only
while the bot has not answered them — its age and an unread dot. A row's mark says what is happening, in the three
states [Code's list](0053-a-run-in-flight-is-the-code-lists-primary-claim.md) draws: grey at rest,
because a chat with nothing waiting is nothing to look at; the spinner while a run is in flight, so
the one row that is working stands out of a list of quiet ones; and, on a row that waits on a question
or an approval, the alert icon in the warning tone with the reason in place of the line — the yellow
spent only on what wants the reader, worded once in `lib/wait-text.ts`. The list is flat on purpose: a second ordering rule — by kind, by
day, by waiting — moves rows under the reader every time something happens. Search filters the title
and the line through the matcher Code's list already uses; a search narrows a list, it never
re-orders one.

**The list is everything the bot is in.** Its own chats, the rooms whose roster seats it (ADR 0138)
and its routines' runs (ADR 0137), each drawn by what it is: a chat's icon, a room's members'
pictures, a routine's timer. A routine's row is the one row whose line and time come off its record
rather than a transcript, because its words are in the run's own session.

**Every chat is a row; the tails are bounded.** The list holds every chat the bot has, however old, so
nothing a pin or an old conversation could reach is left off it. What a row costs is the read of its
newest message — its line, its age, the reply that waits — and those reads are bounded to the newest
fifty chats and every pinned one (`BOT_CHATS` in `lib/chat-list.ts`); a row below that bound draws its
title and its age off the record, which costs nothing to hold. A bound on the *rows* would have been
cheaper still and could not be honest: it would put a pinned chat, or a chat of an older bot, out of
reach of the only screen that reaches chats.

**A bot opens where the reader left it.** Opening the bot opens the chat whose address was last on
screen for it — kept per bot in this device's storage, never synced, since it is where a reader was
sitting rather than a fact about the chat (`lib/last-chat.ts`). A memory that no longer holds — the
chat deleted, or one that has come to belong to another bot — falls to the newest chat the bot has,
and a bot with no chat at all opens its list. Back from a chat returns to the list; back from the list
leaves the app, because the list is a root screen (`BACK_ON_LIST` in `lib/nav.ts`, the state that
tells the list it was stepped back onto rather than opened). `Home` opens the active bot's list.

**The list's own control is the routine icon; a chat keeps its `…`.** The header's `…` went with the
things only it could do, and what the list can act on, a row can act on. In its place the header holds
the one screen a bot's list opens that is not a chat: the bot's routines (ADR 0139).

**Main is an ordinary row.** The record's `main` flag stays, with two readers and no third: a Main
cannot be deleted, and a row that carries it is a chat like any other to everything that draws the list
(the flag is never read there). It sorts by the same clock as every other chat, wears no mark, and is
drawn where its last message puts it — the exception Main used to be was a permanent one in a list a
reader scans (ADR 0120 is where that exception was argued for). Every chat opens on a record now, so
`beginChat` makes a plain chat in both layouts.

**What goes.** `routes/bot-threads.tsx` and its Main redirect; `lib/threads.ts`'s thread half, with
`beginThread`, `handOver`/`takeHandover` and `useStartCommandFor`; `lib/chat-threads.ts`, whose
one surviving answer is `lib/legacy-chat.ts`; `lib/triage.ts`, `triageTurn` in both senders, `/thread` and `/new` in
the composer and `lib/slash.ts`, and the plugin's `triage.py` with its route and its stored triage
model; `lib/moves.ts`, `lib/move-marks.ts`, `lib/placement.ts` and the plugin's `moves.py`; Main's flow
— `components/chat/main-flow.tsx`, `lib/thread-cards.ts`, `lib/main-tail.ts`, the thread card, the
moved marker and the day heading; and the thread lane's `useBotPane` with its four states,
`SPLIT_LANE`, `lib/split.ts`, the split handle and its remembered share, and the `Ctrl+\` chord with
its cheatsheet row. The pane is the list now (`useBotChatsPane`), so a chat keeps its list beside it
from 1280px — or from 1024px with the sidebar as a rail — and the chat has the rest.

**What it supersedes.** [ADR 0120](0120-chat-threads-are-off-by-default.md) — with no threads left to
start, its switch decides nothing, and its synced `threads` record and clock go with it; the only
switch that survives is the Developer one that chooses the legacy Recents sidebar, and it chooses a
layout rather than a chat's rules. [ADR 0113](0113-a-bots-main-and-its-thread-share-the-pane.md) — a
bot's two panes hold its list and the chat that list opened, so there is no share for a reader to drag
and no closed lane to remember. [ADR 0097](0097-a-gap-in-mains-flow-is-one-timeline-not-one-list-after-another.md)
— a flow of cards, markers and day headings is a rule for a screen that no longer exists; what a chat
draws is its messages, with a compaction's divider above the message it sits over (`lib/chat-flow.ts`),
and the one-timeline lesson it taught is kept by the flow that remains.

## Considered options

- **Main kept as the bot's screen, with the list as a lane beside it.** Two ways into one chat, a list
  that has to answer for what Main is doing, and a permanent exception to argue for again.
- **The list grouped by kind** — chats, then rooms, then runs. That is a second ordering rule, and the
  rows a reader looks for would move as their kinds change.
- **A list icon in the header.** The header's control opens the bot's routines; a list icon on the list
  itself would be a control that draws the screen the reader is already on.
- **Migrating every device's `gots:last-thread:<bot>` key into the new one.** One stale entry per bot
  costs less than a migration, and the fallback already lands on the newest chat.
- **Keeping the thread lane's share for the list.** A list is not something a reader sizes: it is the
  pane at its width or it is gone.

## Consequences

- Every thread a device already synced is an ordinary chat in its bot's list, with its own title and
  its own last message. Nothing on the host changes for it: a thread was always a conversation.
- A bot with no chat yet opens an empty list until its first chat or its first routine delivery.
- `bot-threads` leaves the e2e registry, and with it the only browser proof that a pane switch never
  paints the chat it left; `bot-chats` carries that proof, and `docs/e2e-flow-audit.md` records where
  the old flow's legs went.
- The plugin's `sessions/{id}/triage`, `sessions/{id}/moves` and their features are gone: nothing asks
  them any more, so a host still running an older plugin has features no device reads.
- A bot whose host runs an older plugin may still hold routine rows written into a chat's transcript;
  `isRoutineRow` stays so those rows fold as the bot's own message rather than into the reply above.
