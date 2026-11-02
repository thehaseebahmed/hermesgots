# A steer splits the tool group where it landed

**Amends [ADR 0054](0054-a-tool-row-never-lands-between-two-thought-rows.md)**, which rejected
splitting a tool group where something fell between its calls. That rejection stands for what 0054
was deciding: a stretch of thinking is the reply's own work, it draws above the group, and a group
of back-to-back calls stays one unit of the model's work. What changes is the reader's own message,
which is not the reply's work but an interruption of it, and whose chronology is the whole reason it
is drawn in the thread at all.

A steer the run read between two calls was drawn with the entire run above it or below it, never
between the two calls it separated. Both placements are wrong: the calls below the steer ran
*after* the run read it, and until it was read they had not run yet. The reply's words and its calls
share one text offset — a run of calls says nothing in between — so the offset that places a steer
puts every call of the run at the same point, and the only thing that can tell them apart is how
many of them had run. That count was never kept: `Steer` carried a text offset and a time, and a
live turn hands a steer the turn's own time, so no time comparison could order it against the calls
either.

`Steer` now carries `toolsBefore`, the number of the reply's calls drawn above it, stamped where the
steer is folded — the transcript fold (`history.ts`), the live fold (`chat-next/messages.ts`), and
the optimistic part the current screen appends when the host takes the steer. `message-item.tsx`'s
breaks read it exactly as a compaction's `Seam` reads its own count, so a steer that landed inside a
run cuts the run there and the two halves draw as two rows of work with the steer between them.

It does not decide: where a thought row sits relative to a group (0054: above it); whether a call the
thread hides behind a question form moves the count (it does not — the count is the transcript's own
order, as a seam's is); or what a steer does to a reply's text segments (it already splits them, so
rows either side of it never merge).

## Considered options

- **Move the steer above the whole group, and leave the group whole.** Rejected: the reader sent it
  while those calls were running, and the calls the run made after reading it had not happened when
  they spoke. That is the placement this change exists to correct.
- **Place a steer by the calls' times, keeping no count.** Rejected: transcript rows are stamped in
  whole seconds and chat-next hands a steer the turn's time, so a steer and every call of the run it
  split compare equal, and equal times leave the run indivisible.
- **Split the group only where it holds more than one call.** The same rule said for no benefit: a
  group of one call has nothing to split.

## Consequences

- A steer that landed between calls reads as one interruption of two stretches of work, so a long
  tool-heavy turn draws more rows than it did. The alternative was misplacing the message.
- A reply folded before the count was kept has no `toolsBefore` and falls back to the calls' times,
  exactly as it drew before; the next transcript read re-folds it with the count.
- A reply this device drew without the run's events counted every steer it kept at zero, since it
  drew no calls to count. When the transcript catches it up, each steer takes the fold's count and
  keeps the place this device drew it at.
- The count is the transcript's order, so hiding a call behind a question form does not shift the
  calls after it — the same invariant a compaction's seam holds.
