# A card says the same thing whichever way its thread was opened

**A thread's card reads the same whether triage opened it or the reader typed `/thread`.** It had two
shapes, distinguished by how it came to exist: a card whose thread a move opened said `Moved to
“<title>”` and carried Undo on that line, and a card the reader opened themselves said `View
thread`. Two sentences for the same fact — a thread stands here, and the message above it went into
it — and the longer one read as a third kind of marker beside the card, a move report that happened
to be shaped like a link. A reader who had just sent the message and watched it leave Main was told
where it went twice: by the card standing where the message had been, and by the sentence under it
(ADR 0087, amended here).

**The line is the thread's way in, and it always reads `View thread`.** The card's place in the flow
is what says a message left Main: it stands at the opener's own time, under the bubble holding that
message (ADR 0082, ADR 0089). The line's job is to be the way in, and one wording does that job
better than one wording per origin, because the reader never has to work out which sentence this card
carries before pressing it.

**Undo is the one thing that survives, and it stands outside the card.** It is the only fact a
triage-opened card has that a `/thread` card does not — the move can still be taken back until the
thread replies — so it stays. What changes is where it stands and how much room it takes. It rode the
system line, under the card, in a row that had to hold a sentence, a reply count and a control at
once; on the line it crowded the words and pushed a second line of chrome under every triage card. It
now trails the card: the card and the control share one row, the card taking the room and the control
pinned to the row's end, level with the card's middle, the pair still ending on the bubble's own edge
above.

**And the control is its mark alone.** The undo arrow in the info colour, on a 44px round target, and
no word beside it. A word there is read twice, since the card's own arrow and its move already say a
thread left this flow, and in a flow of cards a repeated word is the loudest thing on the screen for
the one control that is an action rather than a description. The mark carries the name for assistive
technology and nothing on the glass, so the row reads as words with one control at its end.

**And the row is the column's width, whose second track is the control's own.** A row that sized
itself to its contents made a triage card narrower than a `/thread` card beside it, so a bot's Main
was a column of cards of two widths telling the reader something by their edges that is not true. The
difference is a control on one card, not a different kind of card. The row is two tracks now, the card
in the first and the second the width of Undo, and that second track is held whether or not the card
can be undone: the live button where there is something to undo, the same mark `invisible` where there
is not, which keeps the box, keeps the column's width identical card to card, and takes the words out
of the reading order and out of reach of a press.

The row also carries the 85% a message bubble caps itself at, and must not. That is a bubble's rule,
since a bubble is only as wide as its words, while a card fills its row by definition: the cap left a
strip of nothing down the right of every card, 52px of it at a phone's width. The row spans the column
now, so a card ends where a message above it ends.

Two things the track must never be. Not a measured constant, because a font scale or a longer word
would clip the control or reopen the band the rule exists to close, and nothing would notice. Not an
`auto` track sized only when a card can be undone, because then the width depends on the control again.
The hidden twin is what makes the second track the control's own size on its own, with no number in the
code and nothing to keep in step.

## Considered options

- **No system line at all on a card, the card box itself the link.** Rejected: the card is also the
  place a thread's state, its reason and its reply count are read, so a press anywhere on it would
  mean "open" while a press aimed at reading would open it too — and a muted thread's card would go
  somewhere for someone trying to read its name.
- **Keep `Moved to “…”` and put Undo outside the card.** Rejected: it leaves the card still saying
  twice what its position says once, which is the whole complaint.
- **Undo inside the card, after the title.** Rejected: the card's row is where a thread's state and
  name live, and a destructive-adjacent control beside the name is one mis-tap from the thread it
  names; outside the card, at the row's end, it is a control on the card rather than part of it.
- **Undo only while the card is the newest thing in the flow (a toast).** Rejected: a move can be
  taken back for as long as its thread has not replied, and a toast has gone long before that.

## Consequences

- `ThreadCard` has one shape. `move` no longer changes what the card says, only whether it offers
  Undo, so `thread-card.tsx` no longer branches its system line.
- Undo's hit area is the row's, not the line's: a test that finds Undo inside the card's line now
  finds it beside the card (`data-slot="thread-card-body"` marks the box Undo stands outside of).
- The moved *marker* — a message that joined a thread that already existed — still says `Moved to
  “…”`: it has no card, so its sentence is the only thing standing where the message was (ADR 0087
  stands for it).
- A bot's Main reads as one list of cards and messages: every card is the same two elements, and the
  one card that can be undone says so with one extra control at its end.
