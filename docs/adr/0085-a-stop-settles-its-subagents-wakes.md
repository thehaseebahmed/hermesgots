# A stop settles its subagents' wakes

The plugin wakes a conversation when one of its subagents ends (ADR 0038), and until now that
included a child the user had just stopped: the wake carried the interruption, the reason the
child's session closed and whatever output it had. So a Stop pressed with subagents at work did what
it was asked — the run ended, the children were interrupted — and then the chat started itself again
a few seconds later, on a run the reader had not asked for and could only stop with the same press a
second time. The report is that shape exactly: "stopping stops everything but somehow triggers the
wakeup run."

A stop is an answer, not news. The child's work is over because the user said so; there is no result
the bot is owed and nothing it could do with one, and the wake turn is a run of the very conversation
the press asked to leave alone. So a stop this plugin carries out — the composer's Stop, a card's
Stop, or the fan-out that hands a stopped run's stop to the children it started — settles the
child's wake with it: `subagent_wakes` takes a `dropped` mark with the reason `stopped`, written at
the stop rather than after the child's row closes, because the sweep reads every five seconds and
may see the end first. A dropped mark is settled, so `runs/live`'s `waking` count no longer reports
the child as owed either (ADR 0057): the session falls to rest as soon as the child ends, instead of
holding a window for a wake that will never come.

What this deliberately does not decide: a child that stopped on its own — a failed or interrupted
unit nothing of ours asked to end — still wakes its bot with its reason and its partial output, and
so does a child the stop could not reach (a host whose registry lost it answers "not running any
more", which is not a stop this plugin made). Nor does it touch the wake's batching, its keys, or
the gates it waits behind (ADR 0052): one disposition is added to a set that already had four.

## Considered options

- **A stopped child wakes as it did, and the app suppresses the wake turn it draws.** Rejected: the
  run is posted, paid for and visible to `runs/live`; hiding it on the screen leaves the host
  working on something the user asked to stop, and a second device would draw it anyway.
- **Reading the stop out of the child's own row** (`end_reason`, or a last row that is a tool call).
  Rejected: Hermes writes `agent_close` for a stopped child exactly as for a finished one, so the
  reading is a guess — and the one writer that knows the difference is the stop itself.
- **Dropping every end that arrives while the conversation has no run.** Rejected: that is the
  normal state of a background subagent, whose result is precisely what the wake exists to deliver.
- **Letting the wake post and having the model reply "nothing to report".** Rejected: it spends a
  turn on the answer the user already gave, and it still reads as the chat restarting.

## Consequences

- `delegation.DROP_STOPPED` is a fifth drop reason beside `stage`, `gone`, `stale` and `exhausted`,
  and the mark is written by `_stop_children`, the one operation every stop comes through, after the
  stops that landed — one store write for a press that stopped several children, and only for the
  ones still owed a wake.
- The mark names the conversation the press came from. No reader of a dropped mark reads that
  column, so a stop that named a session other than the child's own parent is still settled.
- The press is answered on the screen as well: the composer's Stop says it is stopping while the run
  it was pressed for is its job and something is at work, believes a quiet reading only after one read
  of the session's children could have contradicted it, and comes back as Stop at once when the host
  says it took none of the press, when another run takes the button, or fifteen seconds after the press
  itself, which a reading that lands later can shorten but never lengthen — so a
  stop that takes a second to unwind is not tapped twice and one that never landed can be asked for
  again (`app/src/components/chat/composer.tsx`, `STOP_ASKED_MS`/`STOP_SETTLED_MS`).
- Both screens count a session's children from the host's own `runs/live` count as well as the rows
  they read, because the list folds the answers to a stop made on that device and reads quiet while
  the host still holds the child.
