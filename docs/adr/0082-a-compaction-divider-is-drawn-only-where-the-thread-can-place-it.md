# A compaction divider is drawn only where the thread can place it

**Amends the closing-divider half of [ADR 0080](0080-a-card-a-marker-and-a-divider-at-the-foot-of-main-read-one-clock.md).**
0080 settled that the card, the Moved marker and the compaction divider at Main's foot are ordered by
one clock, and that "a divider that closes the flow now means 'after every message'". That reading of
the closing divider is what this ADR takes away; the ordering it fixed stands.

`compactionMarks` places each mark above the first message written after it, on the host's clock, and
hands back what no message follows as `trailing`, which `mainTail` draws at the end of the flow. The
case that reported it: a long turn compacts, and the reader sees the divider under the reply that is
still running — past work that happened before the compaction, and moving up into the reply once the
turn ends and the transcript is folded. The cause is the clock's unit. A running turn is one row in
the thread, stamped when the send opened it (`chat.ts`: `reply.createdAt = now + 1`) and updated in
place as it streams, so every message the thread holds reads as older than a compaction made during
that run. "Nothing follows it" is true of the thread and false of the work: the reply's own rows after
the summary are in the same message, below a divider drawn at the foot.

**A divider is only drawn where the thread can say what it separates.** Nothing in a thread holding a
message is "after everything": the last message may be a reply that spans the mark, and the app cannot
tell a reply that ended before a mark from one that ran past it — a folded reply carries its first
row's time and no end. So a mark with no message after it is not drawn at the foot of a thread that
holds messages. It waits for the message written after it, which is the row it is drawn above, and it
is drawn there with the size it carries. One inside a reply is still drawn at its seam, where the
record is matched by the summary's row (else by the summary's own time) — that is the exact place, and
it is why a compaction made mid-run appears where it fell once the turn is folded. Only a flow holding
no message at all keeps a closing divider: a Main whose every turn was triaged away, or a chat the
compaction itself made, has nothing above the divider and nothing that could carry work past it.

It does not decide whether a rotation that fell mid-reply should wait for the message written after it,
as an in-place mark does. A rotation's mark is the parent session's end, which no row sits on, so no
seam can hold it: the app places it above the next message written — a line between turns, coarser
than where it happened but true of the rows it separates. Suppressing that too would hide every
rotated chat's divider and the size it carries, and the thread has no evidence to tell a rotation that
fell mid-reply from one that fell between turns.

## Considered options

- **Keep the closing divider and let it move up when the fold lands.** The state reported: on a long
  run the divider sits under the running reply for as long as the run lasts, and the reader is told the
  compaction came after work it came before.
- **Stamp a reply's end and compare the mark against it.** The honest test — a mark after the reply's
  last row is genuinely after it — but the thread has no end for a reply: a folded reply keeps its first
  row's time, and a row the host wrote without one is stamped when this device reads it, so the end it
  would compare against is the read's, not the host's.
- **Draw the mid-run divider inside the running reply from the live transcript fold.** Exact where it
  works, and it is what the seam already does whenever the fold has the summary row; the transcript
  read is not running for every turn (events stream, and a keyless chat has no transcript), so it
  cannot be the rule that decides whether the divider shows.
- **Draw no closing divider at all.** A Main whose turns were all triaged away would lose the one
  record it has of a compaction, and the glossary keeps it.
