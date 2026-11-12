# A chat picked from a bot's list opens as the app's only entry

[ADR 0144](0144-a-chat-is-the-root.md) made a chat the root: `/b/<bot>` opens the chat this device
last had open there by replacing its own entry, so back from a chat is the app's. It left one hole in
that model where the list is a screen. The list stands above the chat it covers, and a row picked in
it navigated onto the list's own entry — a replacement — so the chat the list covered, and the reader
had just left, was still at depth 0 behind the pick. The chat picked therefore stood one rung deep:
back from it stepped to the chat the reader had abandoned, not to the app's edge, where the same chat
reached from the bot's own row stands at rung 0 and answers the press with the drawer and the exit
toast. A row picked in a list that was itself the app's entry pushed, so back returned to the list
instead. Two depths, two answers, and neither was "this chat is where the app is".

**A pick is the same move as the landing.** The row opens its chat as the app's only entry: the app
steps back to its first entry and replaces that entry with the chat's address — which is all a page
can do to a stack, a forward entry being beyond a script's reach. A pick made over a chat therefore
leaves neither the list nor the chat under it behind, and a pick made at the app's entry leaves the
list; neither is one press away. The chat picked is the chat its bot opens from then on, because it
is on screen — the memory was never the part that was missing — and everything a root chat does
follows from standing at rung 0: the first press arms the exit and offers the drawer, the second
leaves, the bar's control opens the bot's list above it, and a reload keeps the reader in it.

**The foot's New chat takes the same move**, for the same reason: a chat made from that list is the
bot's chat on screen, and the list it was made from is not a place to go back to.

**What does not change.** A room and a routine's run are not chats of the bot's, so their rows keep
their own screen above the list and their way back is that list. At split widths the bot's list is the
pane beside the chat, not a screen the chat opened: its rows open beside it, and a pick made there
keeps its place in the history rather than flattening whatever the reader arrived through.

The cost is the one the model already charges: the chat a reader leaves is not one press behind them.
A chat is reached from its bot's list, which is one control away in every chat's bar that does not
already have the list beside it.

## Considered options

- **Keep the replacement, and let back from a picked chat reach the chat it came from.** What shipped
  with ADR 0144. A reader who picks a chat to settle in gets an app that answers back with the chat
  they rejected, while the same chat opened from the bot's row leaves the app.
- **Write the picked chat as the bot's memory and open `/b/<bot>` in the list's place, letting the
  landing open it.** One path for both, but two hops and a frame between the press and the chat, and
  the landing would have to be told not to read the list it is replacing as "someone asked for the
  list".
- **Root the pick in the split pane's list too.** The pane's list is not a screen, and the reader may
  have arrived through Code, whose history a pick would flatten.

## Consequences

- `lib/nav.ts`'s `root` takes the state a screen names, so a chat opened this way still tells the shell
  which bot's list it belongs to while its row loads, and `opensAsRoot` is the press a link answers
  with: a plain left press roots the chat, while a press meant for a new tab is left to the browser.
- The bot-chats flow walks the browser's own history: the first pick in a list at the app's entry, a
  pick over a chat, and the foot's New chat — the last two leaving the app to a press back, since
  nothing of either list stands behind them.
- `scripts/test-bot-chats.tsx` holds the move a screen without a session history can see, the entry
  replaced; the steps back through a list are the flow's.
