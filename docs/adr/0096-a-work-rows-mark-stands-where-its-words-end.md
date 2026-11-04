# A work row's mark stands where its words end

**Amends [ADR 0058](0058-a-replys-work-rows-are-one-block-standing-on-the-replys-edge.md) and
[ADR 0092](0092-a-work-row-carries-no-leading-sign.md)** where they settle what stands after a work
row's words.

A tool row says what it did in one line, cut with `(+N)` where the line does not fit, and opens a
sheet with a chevron. That chevron was a flex sibling after a label taking the row's whole width, so
it stood pinned to the row's far right edge — a mark a phone's width away from the words it opens,
and, on a short row, an empty line with an arrow at the end of nothing. The row reads left to right
as it is written; its mark belongs against its words.

**The chevron stands one gap past the words.** A work row's label answers its own text's width, and
what follows it stands where the text ends. Because the label no longer fills the row, the room the
label may use is the row's to measure — the row's width less whatever follows the label and the gaps
between them — and a width change is watched on the row rather than on the label, which now only
grows when its own words do.

**A failure is said under the row, never on it.** A group holding a failed call turns neither its
words nor its row: the row keeps the muted tone every work row wears, its accessible name is what
carries the failure, and the reason stands under it in the destructive tone. On a phone the
destructive label read as the whole run having gone wrong — one failed call among five painted the
sentence red — while the line that actually says why is a row below.

## Considered options

- **Keep the label filling the row and pull the chevron in with a negative margin.** The space would
  be a number guessing at the text's width, and a cut label would still end short of it.
- **Drop the chevron and open the sheet from the whole row alone.** The chevron is the only thing
  that says the row opens anything.
- **Let a failed row keep a red label and only soften it.** The row and its reason then say the same
  thing twice in the same colour, and the row is the half that is wrong.

## Consequences

- `WorkLabel` (`components/chat/work-row.tsx`) loses `flex-1`; both of a reply's work rows draw the
  chevron immediately after their words. The mark is `WorkMark` and the box behind it is `WorkRow`'s
  `data-slot="work-after"`, because a second copy of either is how the two rows drift.
- The measuring box is `WorkRuler`, beside the label it measures: it draws the label's own classes,
  so a code session's line is measured in the face it is drawn in. Measured in the app's sans face, a
  mono line over-counted by 52px at 390px, and CSS cut it with an ellipsis that carries no count —
  the `(+N)` a full row is owed. A webfont that swaps in after the first fit changes those metrics
  without moving the row, so `document.fonts.ready` asks for one more fit.
- The room is the row's width less the `work-after` box and the row's own gap, memoised per width: a
  `ResizeObserver` reports every frame of the sidebar's width transition, and a fit whose room has not
  changed returns before touching layout.
- The sheet a row opens names the whole line it holds: the count is the row's, never the sheet's, so
  the sheet's heading carries no `(+N)`.
- `scripts/test-tool-row-words.tsx` pins the muted row and the coloured note, and the sheet's uncut
  heading; `scripts/e2e/thinking-line.mjs` measures the words-to-chevron gap at every width it plays.
