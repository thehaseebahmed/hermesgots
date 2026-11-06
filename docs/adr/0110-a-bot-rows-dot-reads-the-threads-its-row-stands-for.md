# A bot row's dot reads the threads its row stands for

Two reports about the sidebar with bot threads on, both about what a bot row is allowed to say.

**A coding session selected its bot's row.** The row was tinted for any chat of that bot the address
named, read off `Conversation.profileId` alone — so opening a session at `/c/<id>` lit the bot up as
though the reader were in its Main. A session is a conversation of the bot's, but it is not one of
the bot's **threads**: Code's list is where it stands, its own row is the thing that says so, and a
bot row that claims it says the reader is somewhere they are not. The row now reads `profileId` only
for a chat with no `projectId`, which is the rule `useBotPane` already applies to what the third pane
may hold (ADR 0034) — the two are now one rule in two places rather than one rule and one slip.

**Bot rows carried no unread mark at all.** A bot with something to say previewed its last line, and
that was all: a reader away from the app could not tell a bot that had spoken from one that had not,
short of reading each row's words against their memory of the last ones. The dot Code's rows have
(ADR 0046, ADR 0056) is the app's one language for "new since you last looked", so the bot row
carries it too: at the bot's picture's corner, from the same read marks, on the same rule — a mark
has to exist before a dot can show, and activity newer than it draws one.

**Which threads the dot reads.** Main and every thread the bot has, and never a coding session of
that bot's, though a session is a conversation of its own. The row leads to Main and its preview is
the bot's own words (ADR 0090); a dot raised by a session would send the reader to Main to look for
something Main cannot draw, and tapping the row would not clear it, because opening Main marks Main
and not the session. The Code row already reports a session's news where the session is listed.

**The marks, then, are every chat's, not only a session's.** `chat.tsx` wrote a read mark for a
session only, because a session's row was the only dot in the app; a chat's own thread now writes one
when it renders, measured at the chat's last turn, exactly as a session's is measured at its last
activity (a pull request or a close moves that too). Main is a chat like any other, so opening a bot
writes Main's mark and clears what Main was holding.

## Considered options

- **Read the bot's dot off `waiting`, or off the newest thread's activity alone.** Rejected: waiting
  is a question or an approval, which is a different thing from news, and the newest thread alone
  would call a bot read while an older thread still held something unseen — the row would go quiet
  after a single tap.
- **Count a bot's coding sessions in its dot.** Rejected above: the row cannot lead to them, and a
  dot the reader cannot clear by opening the row is worse than no dot.
- **Seed a mark for a thread this device has never opened, so every unread bot dots.** Rejected for
  ADR 0056's own reason: a wall of dots is a fact about the device, not news about the bot.
- **Keep the row tinted for a coding session, on the grounds that the reader is in that bot's work.**
  Rejected: the tint means "this is the screen the sidebar row leads to", and the session's screen is
  Code's list's, which tints its own row.

## Consequences

- `BotSummary` carries `unread`, computed in `useBotSummaries` from the read marks and the chats it
  already reads — no new read per row, and `useReadMarks` subscribes the list to a mark moving.
- `scripts/test-bot-rows.tsx` holds both rules: a session leaves the row unselected while a thread
  selects it, a bot past its mark dots while an unmarked or a read one does not, and the dot clears
  when the thread it is about renders.
- A bot's dot follows the thread's own last turn, not the sync's arrival, so a turn that landed while
  the app was closed dots the row the moment the row is drawn.
- The glossary's **Read mark** now speaks for a chat rather than a session, since two lists now read
  one store.
