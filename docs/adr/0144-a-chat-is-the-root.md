# A chat is the root, and a bot's list is a screen it opens

[ADR 0136](0136-a-bots-screen-is-the-list-of-its-chats.md) made a bot's screen the list of its chats
and opened it on the chat this device was last in there — with the chat standing *on* that list. The
landing pushed `/c/<chat>` over `/b/<bot>`, the chat's leading control was "Back to <bot>", and back
from the chat walked to the list, which was where the app's history began. But a reader who has used
a bot for a week is in one chat, and every one of those moves asked them about a picker they had
already left: the list they never wanted again was the app's home, and the chat they were reading was
a child of it. So the chat is the root.

**The landing takes the entry it arrives at.** `/b/<bot>` opens the chat this device last had open
there by *replacing* that address's history entry, never by pushing one, and the bot rides the entry
it leaves so the shell keeps the list's lane beside the chat while the chat's own record loads. The
landing fires only at the app's entry, arrived at forwards, with nobody having asked for the list —
so a reload of `/b/<bot>`, a step back onto it and a list a chat's own control pushed over that chat
all draw the list instead. What follows is that the list is never behind the chat: the chat stands at
depth 0, so back from it is the app's, exactly as back from any other top-level screen is.

**A chat is where the app is.** Its address is `/c/<chat>`, and that address is a root: a reload keeps
the reader in the chat, since the chat is the address and nothing has to be restored around it. A
reader who leaves the app in a chat and returns to the bot is put back in it — the same chat, at the
app's only entry.

**The list is a screen the chat opens, from a control in its bar.** A bot's own chat carries the way
to its bot's chats beside the options menu, and the control is a plain push: the chat stays behind the
list, the list's bar leads back to the chat it covers, and Android's press steps to it. A row picked
in a list that stands over a chat takes the list's own entry — a replacement — so switching chats
costs no rung per switch and back returns the chat the reader started in. A row picked in a list that
is itself the app's entry pushes instead, so back returns the list. At split widths the list is
already beside the chat and the control is not drawn.

**The leading control is the app's menu.** A bot's chat leads with the drawer, which is the bar's own
default where the drawer is what holds the bots — not a back control to a list the chat is no longer
under. Nothing leads at all where the sidebar is on screen. A project session under Code keeps "Back
to Code": it is not a bot's chat, and this record does not reach it.

**A press at the root offers the menu as well as arming the exit.** The first press that reaches the
app's edge raises "Press back again to exit" and opens the drawer with it, so a reader whose press has
gone as far back as the app goes is offered another context rather than only a second press. The press
that arm promised leaves even with that drawer standing in front of it — the toast said it would
leave, and a promise an open sheet can cancel is not one — while a press a screen or a pop-up takes
steps back and clears the arm, as a press at another address does. It is the Android app's alone:
there is no exit toast in a browser, so nothing of this reaches one.

**A bot with nothing to open draws its list as the root.** No chat remembered for the bot, or a
remembered one that has been deleted or has come to belong to another bot, is the list — to pick a
chat from, at the app's entry, where back leaves the app. The newest chat is not a fallback: "the
newest" is a guess about where a reader was sitting, and the list is the only honest answer to "there
is nothing to open".

**What it supersedes.** ADR 0136's "back from a chat returns to the list", and the landing paragraph
that sentence sits in: the push the landing left, the list as the app's root screen with the chat
above it, and the fall to a bot's newest chat when the memory no longer holds. It does not supersede
the rest of that record — the list's one order, its rows and the tails they read, its foot
([ADR 0141](0141-a-bots-foot-opens-its-picks-as-pills.md)), its routines control
([ADR 0139](0139-a-bots-routines-are-its-own-screen.md)) and Main as an ordinary row all stand, and
the bar both screens draw is still one component
([ADR 0140](0140-a-child-screens-bar-is-one-component.md)).

## Considered options

- **The chat pushed over the list, with back to it** — what ADR 0136 chose. Back from a chat then
  re-enters a screen the reader did not ask for, and the picker, not the conversation, is the app's
  home.
- **The list as the root and the chat pushed, with the address put back on step back.** Two entries
  for one place in the history, and a reload of the chat has to reconstruct the one it came from.
- **The chat as a row of the list with the list kept beside it everywhere.** A phone would then draw
  two screens for one conversation, and the list would still be the root.
- **"Back to <bot>" leading the chat beside the list control.** Two controls answering the same
  question, and the one on the left would be the app's own back wearing a destination.
- **The list control on every chat screen**, rooms and routine runs included. Those are not a bot's
  chats, and their leading is out of scope here.

## Consequences

- The list's own back at the root, and the app's exit press, are all the app's: `BACK_ON_LIST` in
  `lib/nav.ts` stays, because a room and a routine's run still leave a list their leading steps back
  to, but a bot's chat no longer steps back onto its list.
- A reader who wants the bot's list from a chat presses the control in the chat's bar; a reader at
  split widths already has it beside them.
- `scripts/test-bot-open.tsx` holds the landing as a replacement (`REPLACE:/c/<chat>`, never `PUSH`),
  and `scripts/e2e/bot-chats` walks the browser's own history: the chat opened from the sidebar or
  Home stands at rung 0, back from it leaves the app, a reload keeps the reader, and the list the chat
  opens stands one rung above it.
- A back press on a tablet at split widths leaves the app rather than returning to a `/b/<bot>` pane
  with nothing selected. That follows from the model, and a tablet reader will feel it.
