# A session's stop reaches every subagent it has

A turn that delegates leaves its subagents working after it ends, and until now nothing could call
them off: the composer's Stop belonged to the turn (`busy && !canSend`), and the host's stop reaches a
child only through the fan-out that watches *that run*'s children (`delegation.sweep_stops`), so a
session whose reply was finished and whose subagents were not had no stop in it at all — it read as
working on every screen (Code's rows, a thread's pill) while the only way out was to scroll back to the
card each one was started from, one tap per subagent. A chat that keeps working must be stoppable from
where the reader is.

So the stop is the session's, not the turn's: while anything in a session is at work, the composer's
button is Stop instead of Send, and one press ends the turn if one is live and every running subagent
the session holds, whichever turn started it. It keeps the one-button shape the composer already has —
Stop appears while the box is empty and anything runs, and typing brings Send back, so stopping with
text half-written is done from the subagent line or the sheet. The card keeps a stop of its own, drawn
whenever its agent runs rather than only once the turn has ended, so a subagent can be called off where
it is read about.

Where the work is named, it is named once: a line at the thread's foot — the place the live turn's
`Writing…`/`Thinking…` already sits — reads `2 subagents running` while they run, rides beside the
turn's own activity while that reply is the thread's last row and returns to the foot under anything
the reader sends after it, and opens a sheet listing the session's subagent cards grouped Running then
Finished. The line is drawn by the thread rather than by the reply that started them, because they
outlive it and the reader may send again before they finish — one placement decided for the thread,
so the count is never said twice.

The host answers it in one call. `POST /sessions/{id}/agents/stop` stops every child of the session
core still holds at work and answers what it stopped, advertised as its own feature beside
`subagent_stop`; a host that predates it is asked once per running agent instead, so an older plugin
stops just as well, only slower and with less to say about it.

## Considered options

- **Per-card stops only** — what the app had: correct, but it needs the reader to find every card, and
  a card can be a page of scroll away. It stays as the local stop, not as the only one.
- **The composer's Stop keeping its old meaning** — the turn while one is live, the subagents only when
  none is. Rejected: the button would mean two things in the same place, and a reader who pressed it
  while a turn ran would still have subagents working afterwards.
- **Stop taking Send's place for as long as anything runs** — rejected: a session with a subagent at
  work is a session you may still want to write in, and blocking the send would make the background
  work the user's problem.
- **A stop-all composed in the app from per-agent calls, for every host** — rejected as the only path:
  the host is the only place that knows which children are live, and N refusals are not one answer.

## Consequences

- This supersedes ADR 0038's "once the turn has ended, each subagent is stopped from its own card": the
  card's stop stays, but it is no longer the only one, and it is offered while the turn still runs.
- A subagent can therefore flip to `Stopped` while its card is on screen and the reader touched
  nothing — the composer's Stop, or another device's, reached it.
- The app reads a session's subagents once whenever a session is opened, not only when the thread in
  view carries a `delegate_task`, because the line has to outlive the message that started them.
- A host that can list subagents but not stop them (`agents` without `subagent_stop`) still draws the
  line and the sheet; only the stop controls wait for the route.
