# A gap in Main's flow is one timeline, not one producer's list after another

**Superseded by [ADR 0136](0136-a-bots-screen-is-the-list-of-its-chats.md)** (2026-11-10): Main's flow — cards, moved markers and day headings in one timeline — is gone with Main's screen; what a chat draws is its messages with a compaction's divider above the message it sits over, and the one-timeline lesson stands as the flow that remains.

**Amended by [ADR 0107](0107-a-compaction-divider-stands-between-two-messages.md)** (2026-11-05) on
one of the three items: a compaction divider stands between two drawn messages, so the gap above a
message still holds one, and the foot of a flow holds none. The one-timeline rule stands.

**Amends [ADR 0080](0080-a-card-a-marker-and-a-divider-at-the-foot-of-main-read-one-clock.md)**, which
merged a card, a Moved marker and a compaction's divider into one timeline *at the foot of Main* and
left the anchored ones as they were. That stands for the foot. What it did not settle is the same
three items in the **same gap**: they were still placed by three producers into three lists, and the
flow drew every card of a bucket before the messages', every marker inside the message's own row, so
within one gap a card outranked every marker however the clocks read.

The report was a Main where four messages triage had moved out drew **together**, under one day
heading, below threads that began *after* some of them. Two things made that happen, and both are the
same fault the 0080 fix ended one level up:

- A marker was drawn inside the message it was anchored to, so it could never stand above a card
  whose own time was later: the bucket's cards came first, then the message's own markers. A move
  sent on Friday and a thread begun on Saturday, both above Monday's message, read Saturday,
  Monday — and the moves read as one block because they all fall into one bucket and nothing
  interleaved them.
- A marker had no day heading of its own. It took the anchor message's, so moves from the day before
  drew under the heading of the day after, which is what made "grouped together" read as one entry
  in the flow rather than several items in the wrong place.

**A gap is one bucket too.** `useMainFlow`'s `above(message)` collects what each producer placed
above that message — the cards, the markers and the divider — through `tailItems`, the one function
that turns the three into flow items on their own clocks (`cardAt`, `moveAt`, the host's `at`), and
orders them with `orderTail`: by that time, ties by id. The flow then emits them in that order, each
under a day heading of its own time, and the message under the heading that is its own. Both live in
`lib/main-tail.ts` and the foot is `mainTail`, which is the same two calls — so a fourth producer, or
a clock that reads differently, is a change in one function rather than in a comparator and a copy
of it that the unit tier never runs.

**A divider is an entry, not something inside a message's row.** The compaction's divider used to be
drawn inside the row of the message it was anchored to; it is now a flow entry of its own, standing
above that message, which is the only way a card or a marker made later in the same gap can stand on
the right side of it. Nothing else about a divider moves: `compactionMarks` still decides where it
goes, `useMainFlow` now takes that whole placement (`compacted`) instead of only its trailing one,
and the divider is still held until the chat's own read answers.

It does not decide: where a marker or a divider is anchored (unchanged, `compactionMarks`' and
`placement.ts`'s rules), whether a card and a marker are ever drawn for one message (ADR 0034:
never), or what a card's bubble says (ADR 0090).

## Considered options

- **Keep drawing a marker inside the message's row.** The state reported: a bucket has an order, and
  a row inside it cannot be given one.
- **Sort the finished flow after it is built.** ADR 0080's rejected second ordering: the messages are
  ordered by their stamps already, and two rules over one list is how a flow and its tests come to
  disagree.
- **Give a marker the anchor message's day heading.** The reported symptom, and it hides which day
  the words were typed on.
- **Place all three kinds against the messages in one call and drop `compactionMarks`' own map.**
  That function's rules — one divider per gap, none for a seam a reply already draws, the last one
  trailing — are about a compaction, not about a message's time, so they stay where they are and the
  flow only orders what they hand it.

## Consequences

- `tailItems` and `orderTail` are exported from `lib/main-tail.ts`, with `tailId` naming an item for
  both the sort's tie-break and its React key; `mainTail` is now its trailing case alone.
- `useMainFlow` returns `itemRow` in place of `tailRow`, and `markersAbove` is gone: both screens
  draw a `move` or `compaction` entry like any other flow entry.
- A gap with nothing in it costs one lookup per message: the flow is rebuilt on every write to the
  chat, so it asks the three placements for their bucket and sorts only when there is more than one
  item. A day heading is compared by `dayKey` (the item's local midnight) and formatted only when the
  day changes, so `dayOf`'s `Intl` call runs once per day in the flow rather than once per item.
- `scripts/test-main-tail.mjs` pins the gap order beside the foot's; `scripts/test-main-cards.tsx`
  pins a marker sent before a card drawn above the one message that follows both;
  `scripts/test-compaction-thread.tsx` reads the divider as the entry above the next turn.
