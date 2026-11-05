# A compaction divider stands between two messages, and one stands in a gap

**Amends [ADR 0058](0058-a-compacted-chats-archived-rows-load-as-the-reader-reaches-its-top.md)** on
the divider it said stood above the first message a device holds, **[ADR
0080](0080-a-card-a-marker-and-a-divider-at-the-foot-of-main-read-one-clock.md)** on the divider
joining Main's foot, and **[ADR
0097](0097-a-gap-in-mains-flow-is-one-timeline-not-one-list-after-another.md)** on the divider being
an entry of that timeline wherever it is wanted. Everything those three decided about *where* a
divider falls, and about cards and markers reading one clock, stands.

A compaction divider is produced twice over and placed once. `compactionMarks` puts one above the
first message written after the compaction on the host's clock, and hands back whatever no message
follows as a `trailing` divider for the foot of the flow. A reply whose transcript carries a seam
draws one itself, at the offset and call count the seam names. Nothing matched the two beyond the
record a seam could name: a compaction whose summary row the plugin recorded was left to the seam,
but one it couldn't match — a rotation, whose mark is the parent's end and no seam's time, or a
plugin older than the row field — drew a divider above the next message while the reply's seam drew
its own. Read on a phone, a chat that compacted at the end of a reply opened on two `Compaction`
lines with nothing between them.

The `trailing` divider had the opposite fault. It claimed the compaction came after everything this
device holds, which is true only of a chat nothing has been written in since. A run that compacts
while it writes is followed by words a stream carries and no message does, so the divider was drawn
under a reply that kept printing above it: a boundary under the text it was supposed to close, and
one that would move the moment the next message arrived.

**A divider stands between two drawn messages, and nothing else.** Drawn means a user's words, or a
reply's words or at least one of its calls: a day heading, a thread card, a Moved marker and the
archive's own button are furniture and are not a side. A divider with nothing drawn above it — the
top of a chat whose archive isn't loaded, a Main whose turns were all triaged away — is the device
guessing at a row it hasn't read, and the archive puts the divider back where it happened when the
reader loads it. One with nothing drawn below it is a boundary whose other side doesn't exist yet.
Inside a reply the same test is read off its own parts, so a seam a call sits above and a turn below
is drawn, and one at the head of a thread's first reply is not.

**Between two drawn messages there is one divider.** Where a reply's seam and the host's record both
place one with nothing drawn between them, the one whose label names a size survives — `Compaction ·
168k of 200k (84%)` over a bare `Compaction` — and the earlier one where neither or both do. The
loser is not drawn: a seam that loses is reported back to the reply, which skips it, and a record
that loses is never handed to the flow.

`compactionMarks` makes both decisions and answers with the marks to draw plus the seams to skip, so
the two screens that draw a thread and Main all obey one rule. Its `trailing` mark is gone, and
`mainTail` no longer takes a compaction: a divider at the foot of a flow has no message below it,
which is the one shape the rules forbid.

## Considered options

- **Matching the record to its seam harder.** Teach `compactionOf` that a rotation's `at` is the
  parent's end, so its seam is found and the record is never drawn twice. Rejected as the whole fix:
  it explains one duplicate shape and leaves two *different* compactions in one gap drawing two
  dividers, and a compaction between turns — which has no seam at all — still needs the record's own
  divider. Matching is a placement question and this one is about what the reader is looking at.
- **Hiding the record's divider and leaving the seam.** One line either way, but the survivor would
  move: a reply that compacted at its last word would have no divider at its foot, and the next
  message would carry one above it, so the reader is told the compaction happened after a message it
  happened before.
- **Drawing the trailing divider at the foot of the live reply, inside it.** It would then travel
  down the thread as the run wrote, and the seam that arrives with the transcript would draw a second
  where it actually fell.
- **Keeping the divider above the first message a device holds, on the archive's edge (ADR 0058).**
  It was the closest the app could get while the archived rows were out of reach, but it is furniture
  that says the app is guessing: the archive loads over the top of a chat the reader reaches back
  into, and until then a divider above everything means nothing the reader can act on.
- **A render-time filter in each screen.** The flow can only see what it is handed, and a divider a
  reply draws inside itself is invisible to it, so the two screens would each grow half a rule and
  neither would cover the seam.

## Consequences

- **A Main whose turns were all triaged away draws no divider, even when the host compacted it.** It
  held the only record of where the context it no longer shows was compressed; that is the price of
  the rule, and the archive and the chat's own first message are where that fact is read instead.
- **`CompactionMarks` answers with `replaced`.** The two chat screens hand it to `MessageItem`, which
  skips those seams, and pass the host's record only to the rows that draw one.
- **The rules are proven twice.** `scripts/test-compactions.mjs` drives the marks over a transcript,
  and `scripts/test-compaction-thread.tsx` reads the drawn thread on the chat screen: the two markers
  in one gap collapse to one, and a reply still being written carries none under it.
- **ADR 0058's promise is what the archive is for.** It said the divider "comes to rest where the
  compaction happened, with no second one drawn"; it comes to rest there, and before that it is not
  drawn at all.
