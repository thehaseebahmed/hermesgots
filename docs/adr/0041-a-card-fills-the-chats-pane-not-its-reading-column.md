# A card fills the chat's pane, not its reading column

**Superseded in its width rule by [ADR 0047](0047-a-card-stops-at-the-chats-reading-column-not-its-pane.md)
(2026-10-24):** a card never passes the reading column's 768px box and centres inside it on a wide
pane. Everything else this ADR decided — the pane as the container, the column as the box's own
736px of text, the gutter on the container — stands; 0047 reverses only the width a card takes.

Gots draws a chat in a centred 768px reading column, and its own cards were drawn inside that column — the subagent's card and the answered question card capped narrower still at 448px — so on a tablet or a desktop the panels the app asks a user to read and answer sat small in a wide pane, and one thread could show three card widths at once. We decided that every card the app draws inside a chat fills the chat's pane, keeping the thread's own 16px gutter, while message text and the composer keep the reading column: prose keeps its measure, the panels around it use the screen. It is a no-op below about 800px, where the pane and the column coincide, so a phone is untouched.

Doing it meant moving the reading column rather than widening the pane: the thread's scroll content stops being the column and becomes the pane with its gutter, and each part that is not a card carries the column itself. That order is forced by the structure — a thread's scroll items clip their paint, so a card cannot bleed out of the item it sits in; the container has to be the pane for a card to be wider than the text beside it. The column is therefore expressed as the 768px box's own 736px of text, with the pane's gutters outside it, which lands text on the same pixels at every width.

## Considered options

- **Keep every card in the reading column** — rejected because the complaint is the card, not the text: on a wide screen cards read as narrow islands, and the two halves of one question disagree (768px while it waits, 448px once answered).
- **Drop the reading column for everything** — rejected because prose at pane width stops being readable; the column is what keeps a long reply comfortable, and nothing asked for it to go.
- **Bleed the card out of the column with container-query units** — rejected on the structure: the thread's scroll items use `content-visibility`, which clips paint, so anything wider than its item is cut off. The pane has to be the container instead.
- **Widen only the two cards named first, and leave the rest** — rejected after the consequence was put on the table: a thread would show pane-width, reading-column and 448px cards together, with the same Question changing size the moment it is answered.

## Consequences

- A card added inside a chat fills the pane by doing nothing; one that must not has to cap itself deliberately, against this decision.
- The gutter belongs to the container, not to the cards, so no card carries a width of its own and the approval card — which renders both in the thread and in the composer slot — needs nothing special in either place.
- The thread's box also keeps a scrollbar's room beside its content while the composer slot keeps none, so a card waiting in the slot is that much wider than the same card's record in the thread. Each is right against the container it stands in — which is what putting the gutter on the container means — and the sweep measures each against its own box.
- The reading column is written once and used by every part that is not a card, so the column changes in one place rather than per part: a part added to a reply's parts falls through to text carrying the column, a part without text is stopped by the type until it names its width, and the furniture beside them — markers, headings, footers — carries the same constant.
- The Question's Skip, Next and Send keep their current sizes, left-aligned: the one thing inside a card that does not stretch, decided rather than assumed.
- Width is geometry, which no DOM without a layout engine can measure, so the rule is guarded in the browser sweep (ADR 0019) rather than by any lower tier.
