# A reply's work rows are one block standing on the reply's own edge

**Superseded in its dent sentence by [ADR 0062](0062-a-work-row-wears-no-mark-and-the-status-line-loads.md)**: a failed group's reason no longer takes the label dent — with no mark at the head of a row there is nothing to line up past, so it stands flush under the label at the row's own left edge. Everything else here stands.

A reply draws its working-out as rows — a thought row, the tool group its calls merged into, a
status row while the turn has nothing to show — and each of them is a tap target. Held at the app's
44px, two rows a whole target tall read as a stack of bands rather than as the one passage of work
they are: a "Thought it through" row, then a gap, then "Ran 4 commands", then the answer, with the
reader scanning two full-height bands to get from the thinking to what it did. The rows also stood
4px left of the answer's own text, because a reply's text carried an inset and the rows did not —
so a reply read as three columns a few pixels apart.

Three things change, and they are one decision.

**The reply's inset is owned by the reply's part list.** `AssistantRow` gives every part but a card
`REPLY_INSET` where it draws the part, in one place, and the components that draw a part stop
carrying an inset of their own. The work row is a shape and nothing else; the tool group's failure
reason takes the row's label dent rather than re-deriving it; an interface block's own text stops
insetting itself, since the part it is drawn in already is. A card is still the exception: it fills
`COLUMN_BOX` to its own gutters (ADR 0047), and that exception lives at the part list too. A part
added later lands on the reply's edge by being a part, not by remembering to.

**The pair drops the reply's gap instead of cancelling it.** A reply's parts space themselves with
`space-y-3`, which puts each part's space *under* it, so the part above a work pair takes `mb-0` and
the two touch; the reply's own text keeps the full gap on both sides of the block. `space-y` is what
makes that possible at all — a flex `gap` belongs to the row and cannot be dropped per child — and
Tailwind emits it as `margin-block-end` on a zero-specificity `:where()` selector, so a part's own
margin wins over it without an important or a negative margin to cancel. Nothing had to be pulled
up: at 44px the old row carried a `-mt-2` to close the gap under it, which is exactly the kind of
compensation that drifts.

**The rows stand two thirds of a target tall.** 29px holds the label's 20px line with 4.5px over it
— the smallest height that does not clip it — and turns two 44px bands into one block the eye reads
as a single passage of work. It is the one exception to the app's 44px rule, and AGENTS.md says so.

## Considered options

- **Draw the pair in a wrapper element** — one box holding the thought row and the tool group, so
  the pair is structure rather than a class. It closes the gap and it *remounts the row* the moment
  a tool part joins mid-stream, which closed the sheet a reader had just opened. Rejected: the
  reader loses their place while the turn works.
- **Keep the flex gap and let the pair subtract it** — a `-mb-3` under the row, or a `gap-0` on one
  container. Rejected: the gap is the row's, so the part that wants to touch has to know the row's
  spacing; `space-y` puts the space where the part that drops it owns it.
- **Scope the 29px to a paired row only** — a lone tool group and the pending status row would keep
  44px. Rejected: those rows are read the same way, and a status row taller than the rows it turns
  into makes the block jump as the turn starts. Every work row a reply draws stands at 29px.
- **Apply the inset at each leaf component** — what the first cut did. Rejected: five call sites
  enforcing one rule by memory, and the two that forgot were already 4px off (the media part) or
  needed a wrapper to re-apply it (a failed group's reason).

## Consequences

- AGENTS.md's touch-target rule carries the 29px exception and names ADR 0058; the shape and the
  reason are in that one place, and the code points at it rather than restating it.
- `thinking-line`'s e2e leg measures the block at the reply's own widths — 390px and 1024px in both
  themes — and asserts the row's height, the row meeting its group, the words standing apart and
  every part on one left edge.
- `test-thinking-line.tsx` pins the rule that produces the geometry — a work part takes none of the
  space the reply puts under it, and the parts still space themselves — since a DOM without layout
  cannot measure the pixels themselves.
- The failed-call reason now stands under its row's label by a shared dent, so a change to the row's
  icon or gap moves it with the label instead of leaving it a pixel off.
