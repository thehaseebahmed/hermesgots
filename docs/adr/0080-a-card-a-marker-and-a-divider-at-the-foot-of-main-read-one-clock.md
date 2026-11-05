# A card, a marker and a divider where Main's messages run out read one clock

**Amended by [ADR 0107](0107-a-compaction-divider-stands-between-two-messages.md)** (2026-11-05): a
compaction divider no longer draws at the foot of Main at all — it stands between two messages, and a
Main holding none has no place for it. The cards and the markers still read one clock there.

**Amended in its dot sentence by [ADR 0097](0097-a-gap-in-mains-flow-is-one-timeline-not-one-list-after-another.md)**
(2026-11-04): the three are one timeline in the gaps between Main's messages too, not only at the
foot, and a divider is an entry of the flow rather than something drawn inside a message's row.
Where the foot ends and each item is anchored stand as this ADR decided.

**Amends [ADR 0034](0034-the-bot-opens-main-and-its-threads-are-cards-in-it.md)**, which settled
that every thread's card is drawn "at the time that thread was started" and rejected collecting the
cards in one block at the end of Main. Both stand: a card still sits where its thread began, against
the messages around it, and a message that opened a thread still draws as that thread's card rather
than as a marker. What 0034 never decided is the case where nothing is around it.

A card and a Moved marker are placed against Main's messages by their own time — `threadCards` by
the time the thread began, `moveMarks` by the host's record of the move — and both leave whatever no
message follows to be drawn after the last message. Each screen then appended those two leftovers in
turn: every card, then every marker. So on a Main whose turns were all triaged away — which is what
Main is for — a move made this morning drew under a card begun yesterday, and a message typed after
four triaged ones drew above all four of their markers. The report was a card that "is meant to be
after" the markers under it, and the clock agreed with the reader: the reading was decided by which
list was appended first, not by time.

**The compaction divider is the same producer and joins the same timeline.** `compactionMarks` places
a divider above the first message after the compaction and hands back what no message follows, which
both screens appended after the whole flow too — so on Main a compaction made at eleven drew under a
card begun at twelve. Its record is on the host's clock as a move's is, so it is drawn by it, and a
divider that closes the flow now means "after every message", which is what its own doc has always
said. Two lists were merged and the third was left behind; that is the fault this ADR exists to end,
not a case to be discovered next.

The three leftovers are one timeline now. `mainTail` (`app/src/lib/main-tail.ts`) merges them by
their times — each rule still saying its own item's clock (`cardAt`, `moveAt`, the host's `at` for a
divider) — breaking a tie by id, and the flow holds the result as its own entries, so a screen draws
them in the order they happened and no list can outrank another. A day heading is emitted for a tail
entry's own time, as it already was for a card, or one from an earlier day would read under this
one's divider. The divider in that tail is held until the chat's own transcript read answers:
`useMainFlow` takes the chat's messages as `undefined` while they are unread, and a divider drawn
then would lead the rows arriving under it and jump above them once they landed. A chat that has
answered and holds nothing — the Main this was reported from — keeps its divider.

It does not decide: whether a card sits at the end at all (0034: no — a card belongs where its
thread began, and a tail is the one place no message can hold it); where a marker or a divider
anchored to a message draws (above that message, unchanged); or whether a card and a marker are ever
drawn for one message (0034: never, and a move that opened its thread still yields to that thread's
card).

## Considered options

- **Stack the lists, newest list last.** The state this was reported from: whichever list the screen
  appended second wins every comparison, including the ones time already answered.
- **Collect cards and markers into one block at the end of Main, newest first.** Rejected by 0034
  for the cards, and it would take every card away from the message it belongs against, turning the
  bot's history into a list beside it.
- **Sort the flow after it is built, by the time each entry carries.** The same result for the tail
  and a second ordering rule for the messages, which are ordered by their stamps in the database
  already; one comparator read twice is how a flow and its tests come to disagree.
- **One generic placement over a tagged union of every floating item.** The deeper shape, and the one
  that would stop a fourth producer being appended out of order: it rewrites `placement.ts`, both
  screens and `compactions.ts` to move the order in beside `place`, which is more than this fix
  should carry. `mainTail` names the three producers it knows, and a fourth is a change to that one
  function.

