# A card stops at the chat's reading column, not its pane

Gots draws a chat's text in a centred 768px reading column, and ADR 0041 made every card the app
draws inside a chat fill the chat's pane with its 16px gutter while the text kept that column — and
it shipped that way (#494–#497). But the rule the user gave afterwards is that a card never exceeds
the width of the chat it is drawn in, and the pane-fill broke it: on a desktop a subagent's card ran
edge to edge while the message beside it stayed at 736px, a second layout inside the thread rather
than part of it. This ADR reverses the width half of 0041 and keeps everything else it chose: a card
fills the box it is given and never passes the reading column's own 768px box; where the pane is
wider than the box the card centres inside it instead of stretching to the pane's edges. The
mechanics 0041 wrote still hold exactly — the pane as the container, the column expressed as the
box's own 736px of text with the gutters outside it — because they were chosen for the structure,
not for the width a card takes.

The cap lives in one place, as the fill did. `CARD_BASE`, the width every in-chat card's surface is
built on, is the `COLUMN_BOX` the reading column sits in, so a card added inside a chat stops at the
measure by doing nothing, and one that must be narrower caps itself deliberately against this
decision. Below about 800px the pane and the box coincide, so a phone and a tablet are untouched by
construction rather than by a special case. At 1440px the card that used to fill 1078px stops at
768 and frames the text's 736px column by the box's own 16px gutter on either side, so a card's
first line and the message beside it start on the same pixels.

## Considered options

- **Keep the pane-fill** — rejected on the rule itself: the card is the thing that must not exceed
  the chat's width, and edge-to-edge cards beside a 736px column read as a second layout.
- **Cap the cards back at the 448px they had before #496** — rejected for the split it brings back:
  the waiting Question at one width and the same question answered at another, and a thread showing
  card widths that disagree again, which was the complaint 0041 answered.
- **Cap only the composer slot's cards** — rejected as half a rule: the subagent's card in the
  thread is the one the complaint was about, and one cap on the shared surface covers both.
- **Widen the reading column with the pane instead** — rejected because prose at pane width stops
  being comfortable to read and nothing asked for the text to move; the text is the fixed measure
  and the card yields to it.

## Consequences

- The sweep measures the cap instead of the fill: a card fills its container below the box and stops
  at it above, and a reintroduced pane-fill or a reintroduced 448px cap both fail the wide leg.
- A waiting Question in the composer slot centres inside the slot's gutters on a wide pane instead
  of spanning it, so slot cards, thread cards and the message column all sit on the same measure.
- The approval card still needs nothing special in either place it renders — thread or slot —
  because the cap is on the surface every card shares, not on the container.
- ADR 0041's title no longer names the rule; it stays as the record of the width fight and of the
  mechanics this decision keeps, superseded in its width alone by this one.
