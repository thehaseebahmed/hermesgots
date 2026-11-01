# A reply ends on its status line, and its stats stand above it

**Amends [ADR 0070](0070-the-status-line-is-muted-and-the-count-is-the-only-blue.md)** on one point: the
order its foot is drawn in, for a reply that has finished. Everything 0070 decided about what the line
says, what colour it wears and where the count rides it stands.

A turn that finished while its subagent still worked drew the count of subagents at work on the line,
and then the reply's stats underneath it — `1 subagent running`, then `1,234 tokens · 56 tok/s · 12s`.
The one row of that reply that could still change was above a row that never would, and the reply ended
on a number instead of on the fact that something was still happening. The line is the only row of a
reply that can be live, and the reader's next moment is at the bottom of it.

**The order is one rule: error, "Stopped", stats, the line.** Two of those can never meet the line —
`statusLineOf` answers nothing for a reply that failed or was stopped, and those stand *in* the line's
place — so their order against it was a free choice nobody had made. The other, the stats, is drawn only
once the reply is done and fully revealed, which is exactly when the line's only remaining words are the
count of subagents still at work. Made deliberate, the rule reads: a reply draws what it settled into
first, and its status line last.

**Nothing a reply settled into follows its line.** That is what the order buys beyond the reading. A
thread that wants to say one live thing — the count of subagents at work, or a thread still catching up
(ADR 0066) — can stand that row after the reply instead of inside it, and cut nothing in half to do it.
This ADR does not move the line out of the reply; it takes away the one reason it could not be.

**The working cluster is untouched.** 0070's three rows — the thought row, the tool group's row, then
the status line — are the rows a reply ends on *while it works*, and no stats exist then, so the order
they were given still holds for every streaming reply. The stats join the foot only after the turn is
over, which is the state this ADR orders.

## Considered options

- **Leaving the line above the stats.** The working cluster's adjacency, and what shipped. Rejected: it
  puts the live row above the settled one, ends the reply on its token count, and leaves the line unable
  to move to the thread's side without splitting the reply.
- **Dropping the stats, or moving them into the reply's pop-up.** Rejected: they are the reply's record
  — what it cost, how fast, how long — and the row is already the quietest thing in the foot.
- **Moving the line out of the reply in the same change.** Rejected here, not on principle: it is its own
  decision, with the block's geometry — the line meeting the tool group with no gap, on the reply's edge
  (ADR 0058, ADR 0070) — to be re-proved once the line is the thread's row and no longer the reply's.
