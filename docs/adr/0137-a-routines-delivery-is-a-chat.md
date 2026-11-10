# A routine's delivery is a chat

ADR 0081 made a routine's delivery a message in a chat: the adapter wrote an assistant row at the
chat's compression tip with the display kind `routine_message`, opened with an aside so the model
read it as a continuation rather than its own last words, waited on the chat's turn lease, and
answered the reader's replies with a run that refuses turns. Three things were wrong with it. The
words were the bot's voice in a conversation the bot never had, merged into the reply above it. A
reader who answered was talking to a `cron` run that could not answer back. And every delivery cost a
write into a transcript the app had to be taught to fold around, through a writer Hermes has no
display kind for — the one gap 0081 named as the price of the whole design.

**A delivery publishes a row instead.** The adapter is still a platform, registered with
`ctx.register_platform`, and still gets Hermes's own cron path for free: the ledger, exactly-once
claiming, retries, `[SILENT]`, `deliver: local`, `failure_deliver` and `cron.delivery.notify` are
Hermes's, and the wrapper is still stripped. What changed is where the answer goes. `deliver` writes
one chat record — `routine-<job>-<run>`, the job's id and the run's own session — through
`chats.merge`, carrying the routine's name, the run's session as the chat's session, the delivery's
first line and its time. Nothing is written into any transcript.

**The row is a key, and a repeat is a no-op.** The id is derived from the job and the execution, so a
second delivery of the same execution finds the record and writes nothing, and a record the reader
deleted stays a tombstone rather than being resurrected by a replay. One row per run, not one per
routine: a run is what happened, and sorting or filtering the runs out of a list is a later
mechanism.

**Only what reached Gots is a row.** A silent run publishes nothing, because Hermes suppresses it
before it reaches the adapter at all; a delivery to another platform, or to `local`, publishes
nothing here. A routine that never delivered to Gots has never spoken in the app, which is what a
reader sees.

**The ref is a channel, not an address.** `gots` is the only target, and the adapter accepts any
`gots…` ref and ignores what it names: a job stored as `deliver: gots:main` keeps delivering,
although no chat is addressed any more. Nothing rewrites Hermes's cron store — tidying a name in
another program's database is a worse risk than ignoring the name. `GOTS_HOME_CHANNEL` is written
into the profile's `.env` at register, through the writer linking already uses, because Hermes
resolves a platform's cron target through that variable and a bare `deliver: gots` has no legal
target without one. `push` admits a session a chat record names, so a delivery is still announced.

**Opening a row opens the run.** A routine's row wears the routine's icon rather than a chat's, and
its address is a chat's: the chat screen's picker sends it to a screen of its own
(`components/chat/routine-chat.tsx`) before either chat screen claims it — the run's transcript, read
through `lib/routine-transcript.ts`, under a header naming the routine, with the composer's place
saying why nothing can be answered there. No composer, no steer, no approval: Hermes refuses a turn
on a `cron` session and allows reading it. The run's bar on a bot's routines page opens the same run
(`runRowOf` in `lib/cron.ts`), so a delivery older than any row this device holds is still readable.

**What goes.** `write_queued` and its ticker, `_staged`, the turn lease and the aside openers, the
`sessions/{id}/routines` route, `lib/routine-runs.ts`, the routine message's chip and
`RoutineRunSheet`. `routine_messages` (v51's table) is read once — its queued rows published the way
every delivery is now — and then dropped, since the write path it queued for is gone. `isRoutineRow` stays, with one job: a plugin older than this change still
writes routine messages into transcripts, and those rows must fold as the bot's own rather than into
the reply above.

**What it supersedes.** [ADR 0081](0081-a-routines-message-is-the-bots-message.md) on one point only:
the delivery is not a message in a chat. Its reading of Hermes — that the delivery path is the unit,
that the ledger and the suppression belong to Hermes, that the platform is registered rather than
rebuilt — stands, and this decision is the one 0081's own "a run sheet is a dead end" consequence
pointed at.

## Considered options

- **Keeping the message-in-chat write for a host on the old plugin.** That is what `isRoutineRow` is
  for; writing it anew would keep the writer Hermes has no display kind for, and the turn lease and
  the aside that exist only to hide it.
- **Rewriting stored jobs' `deliver` refs to a bare `gots`.** Rejected: it writes another program's
  cron store to tidy a name that costs nothing to ignore.
- **One row per routine, updated by each run.** A row would then say the routine exists, never what it
  did; a run is the thing that happened, and the row that opens it is the run's.
- **A routine's row opening a sheet over the list.** A sheet is a look at something inside a screen;
  the run is a transcript with its own address, which is how it keeps its place in history and comes
  back to the list.
- **A home channel left unset, so every job had to name `gots` explicitly.** That is 0081's choice,
  and it makes the default a loud failure for every reader who does not know to write it.

## Consequences

- A bot's list gains one row per non-silent delivery, and nothing sorts or filters them yet: that is
  the request's own next step, not a fault of this one.
- A routine's row is deletable like any chat. The run stays on the host and in the routines page, and
  the next run makes its own row.
- A run Hermes prunes reads as no longer on the host (`RUN_GONE`), since a `cron` session is the
  host's to sweep.
- `MIN_PLUGIN_VERSION` rises to this plugin, and `plugin.yaml`, the dashboard manifest and
  `app/package.json` with it: a host below it publishes no rows at all.
- A row queued but unwritten when the plugin upgrades is published on the next start rather than
  dropped, so an answer in flight at the boundary is not forfeited.
