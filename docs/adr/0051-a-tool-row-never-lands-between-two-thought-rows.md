# A tool row never lands between two thought rows

A stretch of thinking draws ABOVE the tool row whose call it follows — above the whole group when
consecutive calls merged into one — instead of below it. A reply whose two calls touch therefore
reads *Thought, Tools*, not *Thought, Tools, Thought*: while the second call of a group ran, the
stretch that followed the first had already finished and was drawn under that group, so two "Thought
for…" rows sat either side of a spinning tool row — the thread working below where it had stopped
working, and the row still working nowhere near the bottom of what the reply had drawn.

Placement is all that moves. Runs are stored exactly as they were, one contiguous stretch of
thinking between tool calls, anchored to the call that broke them; a run of stretches that only tool
rows sit between is still one row, drawn where the first of them was — which is now above those
tools. Everything that is not a tool row still separates rows: text, media, an interface block, a
card, a steer, an approval, another reply. A stretch whose call the thread draws as a tool row draws
above that row, so a group the reader watches run is the last thing its reply has drawn while it
runs.

Two placements are exempt, both of which sit where the reader's eye already is. The pending row —
the turn's spinner before a word of thinking arrives — keeps its place behind the model's last call
(ADR 0050), because a row saying "the turn is working" belongs at the thread's end and never above
tool rows that have already finished; it never draws while a call runs, so it can never be the row
under one. And a stretch that follows a clarify question, a delegated agent's card or an approval
draws after that card as it always did: a card is not a tool row, and the question it asks keeps the
rows either side of it apart.

This supersedes ADR 0049's placement of a run "after the part that holds its call — after the whole
group when consecutive calls merged into one", the sentence "the run after each call lands beside
the other under that group", and its rejected option *"Merge only where no real call sits between
the rows"*, whose stated reason — the reader sees two rows touching and the call is above them, not
between them — is now what the drawing guarantees. ADR 0049's merge, its labels and its sheet stay;
ADR 0050's pending row keeps its place; ADR 0038's runs, spans and label honesty are untouched, since
where a row is drawn has nothing to do with what its label may claim.

## Considered options

- **Withhold a stretch that would draw under a tool row still running** — draw it only once that row
  finishes. Rejected: it repairs the live moment and leaves the finished shape alone, a tool row
  between two thought rows, and it hides thinking that has already happened from a reader watching
  the turn.
- **Split the tool group where a stretch fell between its calls** — rejected by ADR 0049 and still
  rejected here: back-to-back calls stop reading as one unit of work. Moving the rows above the
  group gives the reader the alternation without breaking the group.
- **Draw the stretch after its own call, splitting the drawn order nowhere else** — that is today's
  placement, and it is what puts a finished row under a row still running.

## Consequences

- The chronology is traded, knowingly: a stretch that happened after a call is drawn above it, so
  the thread's working-out reads as one Thought row over the work it led into rather than on either
  side of it. While a turn streams, its newest thinking grows at the top of its work block instead
  of at the thread's bottom — in the row's sheet, since the thread draws labels.
- The e2e `thinking-line` flow's assertion flips from the two stretches that touched drawing *under*
  the group to *above* it, and the mock's own description of the "think out loud" turn says the same.
- Component tests that pin placement move with it; `test-thinking.mjs`'s pure merge rule does not
  change, since merging only ever asked what was drawn with nothing between it.
- GLOSSARY's **Thinking** placement sentence is rewritten to match.
