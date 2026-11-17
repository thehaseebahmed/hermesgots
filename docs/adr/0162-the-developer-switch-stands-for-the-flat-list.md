# The developer switch stands for the flat list

**Supersedes [ADR 0136](0136-a-bots-screen-is-the-list-of-its-chats.md) and takes the Recents layout
with it.**

ADR 0136 made the bot-first list the layout every device draws, and left the Recents sidebar behind
the Developer switch for anyone who wanted the old one back. That was a temporary shape: two layouts,
one of them drawing a list of every chat across every bot, a Rooms section of its own, a Routines row
in the sidebar and a New chat button that started a chat on a screen that was nobody's. The first
layout has since become a bot's Main with its side chats (ADR 0161), and the second is the whole of
what the switch used to turn on — a sidebar chat list that the bot-first layout replaced two releases
ago and that no device has gained anything from since.

**The decision: the switch keeps its key and its off default, and now turns on the flat chat list.**
Off — the app's answer on every device — is the new UX: a bot opens on its Main and its chats stand on
a Side Chat List. On is the single list the app shipped before that: every chat of a bot in one flat
list at the bot's own address, its routines' runs among the rows, all six pills, and — at the split
width — the item lane's "No chat selected" beside it. Main is drawn in it as an ordinary row, because
that layout's address is its list and a Main it did not draw could not be reached.

**The stored key stays `legacyChat`.** It is a device setting and devices have it written; renaming it
would be a migration nobody asked for and a key every other reader would have to learn. What changed
is what it means, and the app says so in code rather than in a comparison: `lib/chat-layout.ts`
answers `"sides" | "flat"`, `chatLayout(settings)` maps on to `"flat"` and off to `"sides"`, and every
reader names the layout it draws instead of testing a boolean.

**Recents goes, code and all.** `components/conversation-list.tsx` loses the Recents list, its Pinned
and Recents bands, the Rooms section only that layout drew, the `/routines` sidebar row and the New
chat button; it is the app's screens, its waiting sessions and its bots. `RoutinesHome` and the
`/routines` route stay, because a failed routine's notification still opens them. `/b/<bot>/sidechats`
under the flat layout lands `/b/<bot>`, since that layout's list is the bot's address.

**A sheet's Archive is offered by both layouts.** The Archived pill exists in each of them, so
`archivesHere` — the branch that withheld Archive where the Recents bands held no pill — is deleted,
and the sheet draws Archive and Unarchive wherever it draws a chat.

**The diagnostic dump says the layout's name.** Its `botThreads` key was the old switch read as a
boolean and described a layout that no longer exists; the key is `layout`, carrying `"sides"` or
`"flat"`.

## Considered options

- **Keeping Recents behind the switch** and adding the flat list beside it. Three layouts is two more
  than the app has a reason for, and the sidebar chat list already had no reader.
- **The switch turning on a "classic" list rebuilt from the new rows** — Main hidden, runs filtered,
  five pills. That is a third screen nobody asked for; the flat layout's value is that it is exactly
  what shipped, routines pill, runs and empty pane included.
- **Deleting the flat list and the switch together.** It would be the cleanest code and the least
  honest: a device that prefers every chat in one list would have nowhere to go, and the request
  keeps the switch.
- **Renaming the key to `flatChat`.** A migration, a version bump and a merge rule for a key whose
  meaning the code already spells out.
- **A `layout` string in the dump that also names the key's raw value.** The dump is read by someone
  diagnosing a stuck screen; the value that decides what they see is the layout, not the switch.
- **Leaving `botThreads` as a boolean derived from the new layout.** It would be a key that says a
  thing the app no longer believes, kept only so an old reader does not break — and no old reader
  reads a dump.

## Consequences

- Every device that had the switch on lands on the flat list, which is where it left them; every other
  device lands on Main, which is a screen it has not seen before.
- The Recents layout's keys stay written where they were; nothing reads them.
- `scripts/test-bot-rows.tsx` holds that neither setting draws Recents, a Rooms section, a routines row
  or New chat; `test-bot-chats.tsx` holds the flat list's screen with its switch on and the bot's
  address landing on Main with it off; `test-back-press.tsx` holds the flat list's guard as the app's
  and the side list's as Main.
- `pnpm e2e bot-list` walks the flat list's order, its panes and its empty item lane with the switch
  on, and `bot-chats` walks Main's addresses with it off.
