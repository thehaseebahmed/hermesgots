# A run in flight is the Code list's primary claim

Supersedes the membership ordering of ADR 0046: "closed first, then any wait on the human … then
the agent running with nothing waiting". The four groups, their order, the colours, the glyphs, the
unread dot and the derived last activity all stand.

0046 put every wait above the agent running, so a session whose run was actually running sat in
**Waiting for You** whenever a wait claim from another source held: its pull request's checks
running or failed, a plan the host had not yet recorded as answered, an approval the run had moved
past, a wait mark a poll had left behind. That group means *your move*, and none of those sessions
was anybody's move but the agent's — while the row's own spinner was hidden behind the pull
request's arrow.

Membership now answers one question first: **is anything running for this session?** Working holds
every session something runs for, and Waiting for You, Idle and Closed hold only sessions nothing
runs for. The session's own run is what decides, and its status is read before every other claim —
`runs/live`'s `running` is the run running, so a wait mark held from a moment before it started
never outranks it, and `waiting_for_approval` is the run *blocked* on the user rather than running,
so an approval or a question still lands in Waiting for You exactly as it did. With no answer from
the host, this device's own newest reply decides: still streaming is the run running, unless an
approval or a question in it waits.

Only among sessions nothing runs for is the rest of 0046's order read: closed, then what waits on
the human (a question, an approval, a plan, a stall), then a live pull request's checks running or
failed, then an open pull request waiting for its review and merge, then idle.

Subagents keep the place they had: a session whose turn ended while its subagents still work is
working, and a question or a plan still outranks those, since that is what wants the user. The row's
second line says why the row waits only while the row's claim is a wait — the reason a poll carried
before the run started is not drawn under a spinner.

## Considered options

- Keep 0046's order and make each wait mark stale-check where it surfaces (the plan on the row, the
  reason in `runs/live`, the checks on the pull request): rejected — every future source of a wait
  claim would need its own check, and the checks one is not staleness at all but a second watcher
  waiting beside the agent. The run's status is the one fact all of them are read against.
- Have the plugin withhold a plan reason beside a run, the way `afk.stalled` never reports beside
  one: rejected as the fix — the app's own `planPending` stays set for the whole turn while the
  host's flag clears at the run's first model call, so the app has to read the run's status first
  either way, and the host's window is the second or two before that call.
- Drop the pull request's checks from the wait claims entirely: rejected — for a session nothing runs
  for, checks running or failed is still the watcher's move, and 0046's rule is what puts it in
  Waiting for You there.
- Let a resolved or discarded mark outrank a run in flight: rejected — a session with a run going is
  working whatever the row carries, and the mark holds again the moment the run ends. Closed is for
  sessions nothing runs for.

## Consequences

- `sessionState`'s first rung is whether the session's own run is in flight; the closed marks, the
  wait marks and the subagents follow it in 0046's order.
- `sessionGroup` claims Working before closed, before every wait and before the pull request's
  arrow, so a running session never reaches Waiting for You.
- A row whose claim is Working draws no wait reason on its second line.
- The waiting group's count is now the sessions really waiting on the user; checks running or
  failed move a session back into it as soon as nothing of its own runs.
