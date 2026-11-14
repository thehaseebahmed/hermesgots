# A conversation sits one step off its bot's list

**Supersedes [ADR 0145](0145-a-picked-chat-opens-as-the-apps-only-entry.md) whole, and in part
[ADR 0153](0153-a-bot-s-list-is-the-way-into-every-conversation.md) and
[ADR 0144](0144-a-chat-is-the-root.md).**

[ADR 0144](0144-a-chat-is-the-root.md) made a chat the app's root: `/b/<bot>` opened the chat this
device was last in there, and a chat's address was where the app stood.
[ADR 0153](0153-a-bot-s-list-is-the-way-into-every-conversation.md) took the memory and the landing
away and made a bot's address its list — but kept the model underneath, so a row picked from that list
still opened as the app's *only* entry ([ADR 0145](0145-a-picked-chat-opens-as-the-apps-only-entry.md)),
and a chat carried a control that opened its list above it rather than standing under one. Two records
were about where a reader lands; neither asked what a conversation's way back is.

The answer the app gave was that there is none: a conversation picked from a list had nothing behind
it, so Android's back, a back gesture and the browser's back button all left the app, and the only way
to the list was a control that pushed a second copy of it over the conversation, or the drawer. A
reader in a conversation who presses back is not asking to leave the app. They are asking for the list
they came from.

**A conversation is one step off its bot's list.** `/b/<bot>` is the list of a bot's conversations —
its chats, the rooms its roster seats, its routines' runs. `/c/<id>` is one conversation. A row of the
list opens its conversation as a push, so the list stands behind it; the two-pane width is a way of
drawing those same two addresses side by side, never a third place. Back — the bar's control, a
gesture, Android's button, the browser's — is then the list, by the history the app already keeps
rather than by a rule of its own.

**A swap between two conversations replaces.** Two rows of one list are siblings, not steps: with the
list beside an open conversation, a second row takes the place the first held, so back from it is still
the list and not the conversation the reader rejected. That is the one place the app uses a replacement
for a press, and it is why a row's link carries a `replace` at the two-pane width.

**The way back is one control in one corner, and it says where it goes.** A conversation's bar — a
chat's, a room's, a run's — carries it last in its right-hand row, named `Back to <bot>`, with the
app's drawer keeping the left where a phone needs it. Routines wears the same control, because it is a
screen of the bot: a bot's screens do not have two conventions for one press. The control and the
platform's guard are one move (`up(list)`), so a control that says "Back to <bot>" cannot answer a
press by leaving the app. It is drawn at the two-pane width too: a reader who wants the list with
nothing beside it asks for it the same way at every width.

**Nothing open beside the list says so.** `/b/<bot>` at the two-pane width draws the list in its lane
and, beside it, a large chat mark over the words *No chat selected* — one state for "the list is the
whole of what is here", at the address that already means it, rather than an item the app picked for
the reader.

**No conversation is remembered.** The memory `lib/launch.ts` kept — `gots:last-chat`, reopened if it
was written within the hour — is deleted with the module, and the crash screen's and the share
receiver's calls that steered it. A launch at `/` renders at once and lands on the active bot's list.
A memory that only a launch reads is still a memory: it decides which screen a reader's first press
meets, and the request this record answers gives it up.

## Considered options

- **The pick rooted, and the platform's back left to the app.** What shipped. It makes a conversation
  the app's only entry, which is honest for a reader who lives in one chat and hostile to the press
  that means "back": nothing is behind them, so the app leaves.
- **A list entry laid beneath every cold conversation** — a reload, a push notification, a shared
  `/c/<id>` — by writing the list into that entry and reopening the conversation over it. It would make
  the browser's back button reach the list even at the app's first entry. It costs a second history
  entry for one arrival and a forward press that returns to the conversation just reloaded; the guard
  already answers the platform's back at the app's entry, and a browser's back at a site's first entry
  is not a page's to intercept.
- **The control as a link to the list rather than a press that steps.** It would push a second copy of
  the list over the conversation it is trying to leave, and back from that list would return to the
  conversation again.
- **Two back controls — one at the left for the list, one in the corner for the app.** Two answers to
  one press, and the left one is the drawer's place.
- **The last conversation remembered per bot, and the pane reopened on it.** What ADR 0136 did, and
  what ADR 0153 deleted: a pane that fills itself with the reader's past answers a question they did
  not ask.

## Consequences

- **Leaving the app from a conversation takes one press more than it did**: the conversation, then the
  list, then the app's exit. Android's exit toast therefore arrives one screen later than before.
- **A conversation opened from somewhere other than the list** — a run picked on the routines page, a
  chat picked in the legacy layout's Recents — answers back with whatever opened it, because `up()`
  steps history rather than jumping. Its control names the bot while the press lands one screen up.
  Such a conversation's own guard still steps rather than leaving the app.
- **A conversation opened cold** answers the corner control and Android's back with the list (the guard
  replaces the entry at the app's first entry); a *browser's* back at the app's first entry still leaves
  the site, as it does from any top-level screen.
- **The page transition changes for a picked conversation**: it slides in from the right as a pushed
  screen instead of fading into the list's place.
- **A launch no longer puts a reader back in the conversation they left** after a process death on a
  phone; the list is what they get.
- Every device keeps the `gots:last-chat` keys it wrote. Nothing reads them and nothing migrates them,
  the same call ADR 0153 made about `gots:last-chat:<bot>`.
- **A row inside a bot's list never roots its conversation.** `root()` still serves the presses that
  open a place — the sidebar's bot row, Home, Code, Settings, a canvas — and the two ways a
  conversation can open as the only entry without being picked from its list: a share that lands on
  one, and the legacy layout's Recents row.
- `scripts/e2e/bot-chats.mjs` walks the new rungs, `bot-list.mjs` measures the empty pane beside the
  list, and `panes.mjs`'s bot section is repaired where it has looked for a "Chats with <bot>" control
  since ADR 0153 removed it.
