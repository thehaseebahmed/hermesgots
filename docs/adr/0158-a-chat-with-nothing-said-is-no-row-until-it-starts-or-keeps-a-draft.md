# A chat with nothing said in it is no row, until it starts or keeps a draft

The New chat press mints a chat's record before a word is typed, because the screen it opens needs an
address to open. Stepping back out of that chat left its row in the bot's list — a conversation nobody
had said anything in, sitting among the ones that had. The plugin's daily sweep already tombstones an
empty session a day later, so the row was never permanent; it was only wrong for as long as it showed.

**The list drops it, and nothing else does.** A bot's list draws a chat when its record has moved past
its own creation (`updatedAt` after `createdAt`) or when the chat holds a draft — the saved one
(`draftAt`, which syncs) or the unsent text this device keeps under the drafts key, which is what a
reader who typed half a sentence and stepped away has. A bot's **Main** thread is drawn whatever it
holds, and a room and a routine's run are never judged by the rule: none of the three is a chat a
reader started.

It is a listing rule, and only that. Nothing is deleted, no screen closes, and a chat that is open
while it stops being listed keeps drawing from its record by id; it comes back the moment a message
lands or a draft is kept. A row this device holds a message for is a started chat whatever its clocks
say — a sync or an import can leave words here under a record that never moved — and that is one read
for the few rows the rule would otherwise drop. The rule lives in `chat-list.ts` as one predicate, and
the one reader of a bot's chats (`chat-rows.ts`) applies it, so the bot's list, the sidebar's bot row
and the legacy bands cannot draw one chat and hide another.

## Considered options

- **No record until the first send (`beginChat` made lazy).** The deeper fix, and the one that removes
  the empty record instead of hiding it. It needs an address for a chat that does not exist yet, which
  is a routing change across every screen that reads a chat by id — much larger than the complaint.
- **Deleting the record when the reader leaves an empty chat.** It races the first message of a chat
  the reader sends from another device, and it throws away a draft that had not been saved.
- **The row kept, and swept by the plugin as it is today.** It is what the reader reported: a row for
  a conversation that has not happened, standing in the list for up to a day.

## Consequences

- Empty records still linger on the device and in the store until the plugin's sweep reaches them, a
  day later. The rule hides them; it does not tidy them.
- A device whose list is drawn by something other than `chat-rows.ts` would draw them again, which is
  why the rule lives with the reader rather than in the screen.
- A chat hidden this way is still reachable by its own address, and by anything that holds its id.
- A chat nothing has been said in is offered no way to put it away: archiving is for a conversation
  that exists, and the sheet that would put a chat away is the only way into one that has not
  happened. The rule still exempts an archived row whatever its clocks say, so a record that somehow
  carries both marks stays a row under the **Archived** pill — and out of every other one, which is
  the archive mark's own rule.
- Archive for a chat and a run is Hermes's own `sessions.archived` flag and not a mark of this app's
  (ADR 0159), so the rows the rule hides and the sessions Hermes hides are the same ones.
