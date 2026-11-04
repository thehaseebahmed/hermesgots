---
status: accepted
---

# A closed session's row is its own screen's to read

A session under **Closed** — resolved or discarded — has no turn left and, as far as a list is
concerned, no branch still moving: the work it began has landed, been dropped, or been abandoned.
The Code list and a project screen still asked after every one of them on every tick — their pull
requests, their worktree, their transcript's tail — and at 226 listed sessions those were the reads
that queued in front of the conversation the user had just opened. Closing a session is the user
saying they are done with it; the list was the one place still not believing them.

So a list leaves a closed session alone. `closedSession` reads the two stamps the app already keeps
(`resolvedAt`, `discardedAt`), and `refreshPrsOf` drops those rows from its due set, `useProjectSessions`
stops reading their transcript tails, `useSessionFollowUps` skips them for its worktree and pull-request
reads, and the pending-checks poll skips them too. The host agrees: the batch route names a session
whose chat is resolved or discarded in `unread` and spends no chain on it, which is what
`chats.closed_sessions` answers for — one read of the chat list for the whole batch, not one per row.
A build older than this rule still pays, because the route can only skip what it can see: the marks
live in the chat list, not in the session's record. A chat deleted outright takes its value with it,
so the session it named cannot be matched at all and is read until the app's own copy knows it is
closed — the one shape this rule cannot reach from the host side.

**Nothing is lost, because opening the session reads it.** The single read a session's own screen
makes — `refreshPrs` from `reconcileHistory`, and the worktree read beside it — is not filtered: the
moment the user looks at a closed row is the moment its content is worth a read, and that is the only
moment it can be. `prsReadable` used to refuse a discarded session outright, which made this rule
untrue for half of Closed: the list stopped asking and opening the row read nothing either. Whether a
session is closed is now the caller's question, not the reader's.

**Considered options.**

- **Keep reading a closed row, only slower.** Rejected: a slower tick is still a read per row per
  tick, and the whole point is that the phone's queue is the bottleneck.
- **Stop reading only discarded sessions.** Rejected: resolved is the more common end, and a merged
  pull request is the least likely thing on the screen to move again.
- **Have the plugin decide for both.** Not taken: the plugin does skip a closed session in the batch,
  but the marks arrive from the chat list on the app's schedule, so a host that decided alone would
  read rows the app already knows are done, in the window before the sync lands.
- **Drop the row from the list entirely.** Rejected: Closed is a group the user scrolls, and its rows
  are the record of what they finished.

The cost is freshness on a closed row that moves again without being opened — a branch pushed to
after its session was resolved, or a pull request closed later. It is bounded by the same thing that
makes the rule cheap: opening the session is one read, and it is the only time that row is looked at.
