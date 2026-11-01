# The thread decides its one live row, and the reply draws it

**Amends [ADR 0075](0075-a-reply-ends-on-its-status-line-and-its-stats-stand-above-it.md)**, which took
away the reason this could not be done and left the move itself to its own decision. The order 0075
fixed stands; what changes is who decides what the row says.

A thread could say one moment twice. With its first transcript read still out it drew the catch-up
line — "Gathering…" — and, where a reply's own row was still working, that reply drew its line too, a
row later. Two rows, two loaders, one moment. Fixing the count only moved which row carried it: the
rule for the count still lived beside the rule for the words, in two places, with the catch-up line
drawn by the thread and the working words drawn by the reply.

**One rule decides the row.** `threadLineOf` in `src/lib/thinking.ts` answers the thread's one live
row and what it says: while the thread catches up, the catch-up line — it stands where a reply's line
would (ADR 0066) — so the count of subagents at work is its only words and its one loader turns in that
count's blue; otherwise the last reply's own line, decided by `statusLineOf`, the same rule a screen
with no catch-up line has always used. Where the thread has no reply to speak for, the count stands
alone without a loader, as it always did. The reply's facts are read off its own row by `replyFacts`;
the activity its words come from is handed in, because `format.ts` owns it and the rule reaches
nothing.

**One renderer draws it.** `LineRow` in `status-line.tsx` draws a decided line: its words, the dot, and
the count where the decision put it — riding the words, alone, or alone and turning the loader. The
reply's foot and the thread's own row both draw through it, so no screen can word or colour the row
differently. A reply is handed the decision (`line`), and a screen that decides for itself — the
current chat screen, which has no catch-up line — hands nothing and keeps `statusLineOf`.

**The row is still drawn in the reply where there is a reply to hold it.** This is the point 0075
guarded: the line meets the tool group with no gap, on the reply's inset, and the thinking-line flow
asserts that block. So the decision moves to the thread and the drawing stays in the reply's foot — the
thread draws the row itself only where the last reply draws none (no reply yet, or one that ended on
its error or "Stopped"). Hoisting the element out of the reply, to sit as the scroller's own item,
would put a 24px item gap where 12px of one block was, and that is a layout decision nobody asked for.

## Considered options

- **Suppressing the reply's line while the catch-up line stands.** The smallest fix, and it stops the
  duplication. Rejected: it leaves the catch-up row outside the reply and the reply's rule beside it,
  so the two can disagree again the next time either is touched — which is how this report arrived.
- **Drawing the line as a scroller item after the last reply.** The literal hoist. Rejected for the
  gap: the block's geometry is asserted, and a detached row reads as a new turn's.
- **Keeping the count's home as its own rule.** What shipped first. Rejected once the words had to be
  decided too: two rules for one row is the shape that produced two rows.
