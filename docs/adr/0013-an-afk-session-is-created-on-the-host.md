# An AFK session is created on the host, chat record and all

The plugin creates an AFK session end to end: it calls the same `sessions.ensure` the app's workspace route
calls — which is what makes the worktree, the branch name, the session's cwd override and its
`project_sessions` row — starts the run itself through `outbox.post`, and writes a chat record into its own
chat list carrying the Hermes session id, the project, the title and the mode.

That record is the part that is easy to miss. The Code list hides a session nothing was sent in, and a chat
the device has no conversation for bounces to the new-chat screen, so a session the plugin made would be
invisible and unopenable until the plugin published it. The chat list is the one channel the app already
pulls for chats it has never seen — a fresh device materialises every record the plugin holds — so the
plugin writes the session there rather than leaving the app to invent a conversation for a session it
didn't make. The alternative, the app creating the conversation the next time it opens, would mean the work
only becomes real when the user returns, which is the opposite of what the switch is for.

## Considered options

- **The app creating the conversation on its next sync.** Rejected: the task would be running with nothing
  in the app to open, and a session the user cannot watch while it works is not the feature.
- **A screen of Gots's own for AFK sessions**, the way a research mission has its own screen and never needs
  a conversation. Rejected: an AFK session's whole value is that it is an ordinary project session — its
  transcript, todos, pull requests, and the composer the user takes over with when they come back.
- **A conversation made when the switch is turned on, filled in as tasks arrive.** Rejected: sessions are
  per task, and a task can appear at any time while the switch is on.

## Consequences

- The record's `updatedAt` has to be newer than its `createdAt`, or the Code list hides the session by the
  same rule that keeps an empty draft out of it.
- An AFK session is an ordinary project session: the composer, the PR pill, approvals and Resolve/Discard
  all work on it unchanged, and the app needs no new session type.
- The chat list is last-write-wins per record, so the plugin must write the record once and leave it alone
  afterwards — a title the user edits, a mode they change or a resolve they make all have to win.
