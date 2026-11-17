# Code is drawn as a bot's chats are

Code's list and a project session were built before the bot's chat list and its chats, and had drifted
from them: a list grouped by state under its own header, a floating New session pill, a search behind a
bar button, and a session whose header carried a `…` menu where a chat's title opens a sheet.

**The decision: Code is drawn by the parts a bot's chat list is drawn by, and a session's edit options
are the chat's sheet.**

- The list is one flat band — what the reader pinned first, then the order the sort menu says. The four
  state groups are gone; a row says its state with its icon, tone, spinner and unread dot, as a chat's
  row does. The project chips stand in the bar's pill slot, the search in the bar from the laptop width
  and in the foot below it, and the foot's round `+` starts a session (`ListFoot`'s `onNew`, which opens
  no picks since Code has one thing to start).
- A session's header keeps its centred arrangement and its subtitle, without the `…`. Pressing it opens
  `ChatSettings`, which for a session also holds its context, every repository it works in, its pin and
  its Resolve/Reopen, Discard and Delete. The subtitle names the first repository and counts the rest
  (`Gots · hermesgots +2 more`), at every width.

**Cost, known.** Waiting for You was the one place to look for what needed the reader; it is now a row's
alert icon and warning line in a list ordered by the reader's key. Resolve and Discard are one tap
deeper. A session nothing has been sent in has no title to press and so no sheet; leaving it deletes it
as before. This reverses AGENTS.md's earlier line that a session keeps its `…` because its resolve,
discard and delete are not a chat's settings.
