# Main's flow stands each item at the time its message was sent

**Amends [ADR 0080](0080-a-card-a-marker-and-a-divider-at-the-foot-of-main-read-one-clock.md)**,
which put a card, a Moved marker and a compaction divider on one clock at the foot of Main. That
stands: the three leftovers are one timeline, and nothing stacks one list after another. What it did
not settle is whose clock each item reads — and two of them were reading the host's, not the
message's.

A card was drawn at the time its thread's *record* was created and a Moved marker at the time the
host *recorded the move*. Both are the host's own bookkeeping, and both land after the moment the
reader typed the words: a thread opened from a message typed at nine can carry a record stamped a
second or a minute later, and a move is recorded when the host queues the message on its thread, on
the host's clock, which this device's clock may run behind. So a message typed after a move could
draw above it, and a card could sit below a message written before the thread began. The report was
threads out of order in Main, with the cards and markers not beside the messages they belong to.

**One clock, and it is the message's.** The triage ask carries the message's own send time, and the
host records that time on the move rather than the moment it got round to handling it: `moves.at` is
"when the reader sent this", whatever the host did next. A thread's card is placed at its opener's
send time — `openerAt`, published with the thread's record (see
[ADR 0090](0090-a-threads-card-draws-the-opener-the-host-recorded.md)) — falling back to the
record's creation time only for a thread whose opener the host never carried. The flow is then
ordered by one fact a reader can check against their own memory of typing it, and nothing the host
does afterwards moves anything: not a move, not a retitle, not a sync that lands late.

`movesFloor` goes with this. It existed because a move's stamp could run ahead of this device's
clock, so a turn typed after the move was stamped before it and drew above the marker; with the
stamp coming from the device that typed the message, a later turn is already later and the floor has
nothing to raise.

**A marker stands beside its bubble, and the pair is one item.** The bubble is the message and the
line under it is what happened to it; splitting them — a marker ordered by one clock and its bubble
by another — is what made a moved message read as a message in one place and an event in another.

It does not decide: where a marker or a divider anchored to a real message draws (above that
message, unchanged); whether a card sits at the end at all (ADR 0034: no — a card belongs where its
thread began, and a tail is the one place no message can hold it); or what a card's bubble says
(ADR 0090).

## Considered options

- **Keep the host's clocks and only fix the interleaving.** The order would still disagree with the
  reader's own memory of when they typed, which is the thing they were reading it against.
- **Sort the finished flow by a timestamp each entry carries.** Two orderings for one flow — the
  messages by their stamps and everything else by a derived value — is how a flow and its test come
  to disagree, the mistake ADR 0080 already rejected once.
- **Read the message's time back from the host's transcript for every marker.** A read per item on
  the screen, for a fact the ask already has in hand when it is made.

## Consequences

- `lib/triage.ts` sends `at` with the ask; `plugin/moves.py` stores it and `plugin/triage.py` passes
  it through, so `main_moves.at` is the message's time on every device and after a reinstall.
- `cardAt` (`lib/thread-cards.ts`) reads the opener's time, and `scripts/test-thread-cards.mjs` pins
  a card that sits by its message's stamp rather than its record's.
- `movesFloor` and its `MOVE_GAP` are gone from `lib/move-marks.ts`; the send path no longer raises a
  new message's stamp past the newest move's.
- A host whose plugin predates this keeps stamping moves when it records them, so an older host
  still draws a marker later than the message it moved. The app reads what the record says and does
  not correct for it.
