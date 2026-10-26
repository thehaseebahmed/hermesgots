# A wake still owed keeps the session working

Between a turn ending and the wake turn its finished subagents owe starting, the session reads
`working`, not `idle`. That window — no run in flight, nothing streaming, no subagent at work, the
bot a beat away from carrying on — used to be read as the session at rest, so a reader watched a
session stop and then start again of its own accord: the subagents finished, the main run had
already finished, and for the seconds the plugin takes to detect the end and post the wake the chat
looked stalled. The fix is a fact at the source rather than a guess at the clock: `GET runs/live`
carries `waking: { <session_id>: <count> }` — how many finished subagents each conversation's wake
is still owed (`delegation.waking_sessions`, every ended subagent no sweep has settled yet, keyed
by the chat's root like the rest) — and `sessionState` reads it as another rung of `working`,
between what wants the user and nothing at all. A plugin too old to report the field leaves it out
of the answer, and an app that never sees it keeps every session exactly as it was.

The fact is measured where it exists. The plugin already knows what is owed: `_unwoken` is the one
read the sweep takes and `waking_sessions` the one `runs/live` takes, off the same watermark and
marks, so the app is told the wake is owed from the moment the subagent ends — before any sweep
posts it, and while a held or backing-off wake keeps it owed for as long as it takes. Nothing in
the app infers the window from a timer, and no surface renders differently depending on when its
last poll happened to land.

## Considered options

- **A grace period in the app** — read a session as `working` for N seconds after its run ends,
  since a wake usually arrives inside that. Rejected: it is a clock standing in for a fact. The
  window's real length belongs to the plugin's sweep, its gates and its backoff; a fixed period
  would be too short when a question holds the wake and too long when nothing is owed at all, and
  the session would read `working` after a turn that ends with nothing to wake.
- **Pushing the fact through the run's own events** — a `waking` event on the change stream the app
  already follows. Rejected: `runs/live` is the poll every screen already reads for `subagents`,
  `waiting` and the run itself, and a fact that arrives only where a stream is open would make the
  window depend on the transport; the field rides the answer the poll already takes.
- **Having the plugin start the wake sooner** — collapsing the detection latency instead of
  reporting the window. Kept out of scope: the wake's timing is ADR 0038's and ADR 0052's (held
  behind a question, an approval or a live turn, batched per conversation), and reading the window
  correctly is what the screens needed either way. The measurement stands beside it: the owed fact
  exists in `runs/live` from the end's own record, before any sweep could post the wake, so the app
  learns of the window as early as the plugin does.

## Consequences

- `runs/live` grows one optional field, `waking`, beside `subagents` and `waiting`; `waiting.ts`
  merges it across bots like the rest (`useLiveWaking`), and `sessionState` reads it after
  `waiting` — a question or approval still claims the session first, since that is what wants the
  user — so the Code screen's groups, a chat's thread card and `threadState`'s pill all keep
  reading `working` through the window and fall back the moment the wake turn appears.
- A conversation can hold the fact while a wake is held or backing off, however long that takes:
  the count clears only when the wake turn starts (or the end settles `dropped`), so `working`
  never depends on the window being short.
- An older plugin omits the field and an older app reads it as `undefined`; both degrade to the
  behaviour this ADR replaces, with no error and no retry.
- `pnpm e2e wake-window` holds the wake back in the mock (`POST /__mock/wake { delay }`) and
  watches the window in wall-clock time: the card sampled again and again across a navigation to
  Main, red if it ever falls to at rest before the wake turn starts.
