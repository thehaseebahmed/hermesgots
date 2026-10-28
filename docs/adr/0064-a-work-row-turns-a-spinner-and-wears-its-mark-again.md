# A work row turns a spinner and wears its mark again

**Supersedes [ADR 0061](0061-a-working-row-waves-and-the-status-line-types-itself.md) and
[ADR 0062](0062-a-work-row-wears-no-mark-and-the-status-line-loads.md)** — all of 0061, and 0062's
mark-free row with it. What 0062 decided about the status line under a reply stands.

ADR 0061 took the spinner off every row a reply draws for its own work and put the movement into the
row's words instead: a wave travelling through a thought row's label, and through the tool group's
row while a call ran. ADR 0062 then took the failure mark off those rows too, so the red X a failed
group wore went with the icon slot and a row could wear no mark at all.

Both are reversed. A work row carries a spinner ahead of its label again while it works, and a
failed group wears its X again with the reason line dented under it.

**The words were the thing the wave moved.** A work row is a sentence — "Thinking…", "Running bash,
read parser.ts" — and the reader is reading it while it moves. On the phone this app is built for
that sentence is short and small, and a light travelling through it is a shine over the words rather
than a sign beside them: it competes with the reading instead of carrying it. An icon in its own slot
says *this row is at work* without touching a letter, and it says it in the place the reader has
learned to look for it — a row that has lost its slot also loses the one glyph that says work is
running at all.

**A failed row's mark is the fastest read of three rows.** 0062 was right that a failure is said in
words — the row's name gains `failed`, the reason stands under the label — but the words are what a
reader gets to after the mark has already told them which of the three rows went wrong. The X comes
back with the slot it stands in, and the reason takes its dent back with it: a line under a row's
label lines up under the words, past the mark (ADR 0058).

**The spinner says nothing to assistive tech.** The row's own name and its label already say what it
is doing, so the restored spinner is `aria-hidden` rather than the `Thinking…` it announced before
0061 — 0062's rule that a thing is said once, applied to the slot. That is the one place this ADR is
not a plain restore.

**The status line is untouched.** A loader beside words that stand whole, both in the accent colour,
muted with no loader while the turn waits on the reader: that is ADR 0062's decision and this ADR
does not reach it. The wave was the only thing this pair of decisions shared.

## Considered options

- **Keep the wave and slow it down.** Rejected: the objection is that the words are moving, not how
  fast they move.
- **A mark that is not a spinner** — a dot, a bar, the chevron lit. Rejected: a new glyph in a slot
  every other app fills with a spinner passes the cost onto the reader to learn, and the app already
  draws spinner in that slot in lists and sheets.
- **Rows with no sign at all, the status line alone moving.** Rejected: while a thought row names the
  thinking the status line says nothing (ADR 0050), so a turn whose thinking is arriving would show
  nothing moving anywhere on the screen.
- **Take the failed group's words back to 0061's** — the count out of the row's name. Rejected: the
  name and the reason saying different amounts was the duplication 0062 fixed, and it is not what
  the mark was for.

## Consequences

- `WorkRow` carries `before` again, and `WORK_LABEL_DENT` returns with it, so a reason line and the
  label it explains stand under one left edge. The note loses the pull ADR 0062 gave it at the same
  moment: that pull closed the half-line a row with no mark left under its label, and with the dent
  back the note's own line box is the only gap it needs. `WorkLabel` and the `.work-wave` keyframe go,
  along with the `useReducedMotion` hook whose only reader was the wave.
- A working thought row, the row a turn wears before a word of thinking arrives, and a tool group
  while any of its calls run each draw a spinner before their label; a group whose calls failed draws
  the X where it is not running. Reduced motion is the spinner's own: `motion-safe:animate-spin`
  leaves the ring drawn and still.
- `scripts/test-thinking-line.tsx` and the `thinking-line` browser flow read `[data-slot=spinner]`
  again for a row at work, and `test-tool-row-words.tsx` the mark on a failed group.
- Kept from #647, because none of it was the wave or the slot: the `failed` wording in a row's
  accessible name with the count said once, `WorkNote` and its `data-slot`s, the blue subagent line
  and its dot, and `media.ts`'s one motion preference for work outside a component.
- `GLOSSARY.md` loses **Wave** and its **Work row** and **Thinking** entries wear a spinner again;
  `docs/specs/work-rows-wave-and-status-line.md` is stamped reversed. Ticket #639's wave is the
  passage that goes.
