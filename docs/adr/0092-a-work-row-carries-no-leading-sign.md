# A work row carries no leading sign

**Amends [ADR 0058](0058-a-replys-work-rows-are-one-block-standing-on-the-replys-edge.md),
[ADR 0064](0064-a-work-row-turns-a-spinner-and-wears-its-mark-again.md) and
[ADR 0075](0075-a-reply-ends-on-its-status-line-and-its-stats-stand-above-it.md)** where they settle
the sign at a work row's start — the spinner that says the row is working, the mark a failed group
wears in the same box, and the empty box a finished row keeps so its words do not move. What they say
about a row's height, its muting and its one-line shape stands.

The reserved box was the price of never reflowing a finished row, and on a phone it reads as a gap:
29px of nothing at the start of every "Thinking" and every tool row, with the words pushed off the
reply's own left edge for a sign that is absent most of the time. Two rows that differ only in
whether they are still working then start in two different places, which is the jump the empty box
was meant to prevent.

**The row starts at its words, and works by them.** A row at work pulses its own label — the muted
colour it already wears, breathing rather than shimmering — and its label alone: no box, no mark, and the same
left edge whether it is running, finished or failed. A failure keeps its own line under the row (the
reason it already draws) and turns that row's words destructive, so the state is said by something
that does not sit in the flow's start. A thought row pulsing reads as the same shape a tool group
pulses in, which is the point: the pair are one kind of row (ADR 0050).

**The status line keeps its sign.** It is the one row whose loader is the whole line — a turn that
has said nothing yet is a spinner and a rotating word, and that word is the only thing on the line
that changes — so its sign stays where it is and the line is unchanged.

It does not decide: the height of a work row (0058: 29px), the word a row says while it works, or
whether a note under a row is dented (it is not: with no sign to clear, the note stands on the row's
own edge).

## Considered options

- **Keep the box and swap the spinner for a static glyph.** The gap and the 29px of nothing at the
  start are the complaint, not the animation.
- **Put the loader after the words.** A row's words grow and truncate; a mark that follows them moves
  on every token, which is a worse jump than the one this ends.
- **Leave the row's words alone and say "working" only in the status line.** The thinking row is the
  one place a turn says it is thinking (ADR 0064), so a reply that thinks and runs nothing would
  otherwise draw a still row over a still line.

## Consequences

- `WorkRow` (`components/chat/work-row.tsx`) takes no `before`; `WorkSign` stays for the status line
  and `WorkNote` loses its dent.
- `ThinkingLine` and `ToolGroup` pulse while they work — `data-working` on the row, with the pulse
  in `index.css` and honouring `prefers-reduced-motion` — and a failed group's words are
  destructive.
- `scripts/test-work-row-slot.tsx` is rewritten around the absence of a slot: every work row starts
  on the reply's edge in all three states, and the status line still carries its spinner.
