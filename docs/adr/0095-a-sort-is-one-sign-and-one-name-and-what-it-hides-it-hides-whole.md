# A sort is one sign and one name, and what it hides it hides whole

**A sort control reads one sign and one name, and the sign comes first.** It had three marks in a row
— the up/down pair meaning "this is a sort", the key's name, and the direction arrow at the end —
which is a control with two icons doing the work of one: the pair says what the control is, the arrow
says what order the list is in, and every list that sorted itself drew both. The pair is gone. What
is left is the direction arrow at the control's start and the key's name after it, so the control
reads as a list's order rather than as a menu with a badge: `↑ Created`, `↓ Last activity`. The menu
behind it is unchanged, and its chosen row still carries the same arrow, so the sign a control wears
closed is the sign that row wears open (ADR 0091, amended here).

**The arrow at the start is also a statement about the control, not just the list.** A direction
alone reads as "this flips": pressing the control opens the keys, picking the chosen key flips it,
and the arrow turns in place — one sign that shows and changes the order, in the position a reader
looks at first.

**A row of filters that runs under a control has to go out of sight whole.** Code's project chips
scroll sideways, and the sort stands at their right end. It had a gradient fading the chips to the
page's colour before they reached the sort, and the sort had no ground of its own: a chip scrolled
far enough showed through the button's edges and, with a long chip list, was cut off mid-word at the
sort's boundary — two things happening at once at the same edge, and neither reading as intent. The
sort now stands on a dock: the chips run the row's whole width and go on *beneath* it, the dock paints
the page's own ground so nothing shows through the button, and its leading edge is a gradient from
transparent to that ground, so the chips fade out of sight instead of being sliced. The row carries
trailing padding enough for the last chip to come to rest clear of the dock, because a filter the
reader cannot scroll to is a filter they have lost.

## Considered options

- **Keep the pair icon and drop the trailing arrow**, leaving the direction unstated until the menu
  opens. Rejected: the direction is the part a reader checks at a glance, and the menu is where they
  go to change it.
- **An icon-only trigger, the key's name only in the menu and the aria-label.** Rejected for this
  surface: three of the four lists that sort themselves have room for the name, and a control that
  names its order is read without opening anything.
- **A hard edge on the dock, no gradient.** Rejected: a chip's word disappears between two frames,
  which reads as a rendering fault rather than as a row going out of sight.
- **Shadow only, no ground.** Rejected: a shadow over the chips still shows them through it, which is
  the report.
- **Clip the chips row at the sort's left edge instead of running under it.** Rejected: the chips
  then stop short of the sort with a hard cut and a strip of nothing between them, which is the
  "broken" edge the report names.

## Consequences

- `SortMenu`'s trigger drops the up/down pair icon; its aria-label still names the key and the
  direction, so nothing is lost to a screen reader.
- Code's filter row is `relative` with the sort dock absolutely placed at its right end, and the
  chips row takes `pr-16` so the last chip clears the dock. A second surface that puts a control over
  a scrolling row follows the same three parts: full-width row, opaque dock, soft leading edge.
- `ChipRow` takes an optional class, because the trailing room a row needs is the row's business and
  not a prop of every chip in it.
