# Code searches under its title and sorts beside its search

**Supersedes [ADR 0093](0093-code-searches-from-its-header-and-sorts-beside-its-projects.md)**, which
turned the list's title into the search field and moved the sort onto the projects' row, and **amends
[ADR 0095](0095-a-sort-is-one-sign-and-one-name-and-what-it-hides-it-hides-whole.md)** where it says a
sort always reads one sign and one name. What 0093 says about the matcher and about a query closing
stands.

Three things were wrong with that shape at once. A title that turns into a field is a title the reader
cannot read while they filter, and the field it becomes is a control drawn in the bar rather than the
row of the list it filters. The sort left the header for the project row, where it was pinned over a
row of chips that scroll behind it — a control for the whole list standing in the band that cuts the
list by project. And the projects lost part of their own row to a dock measured in JavaScript.

**The search is an icon in the title bar, and the field it opens stands under that bar.** The bar
keeps its title: *Code*, and at its right end two signs, search then sort, left to right. The search
icon toggles the field below — the row the field held before it became a control — and it stays the
search icon while it is on, reading as pressed rather than turning into a close button: one control
that says what it is, with its state said by the plate under it. The field closes on that icon again,
on its own clear button, or on Escape, clearing the query as it goes, because a filter nobody can see
is a list missing rows for no stated reason. **The sort is a sign too** — the direction arrow alone,
its key named in the menu and in its accessible name — amending ADR 0095's one-sign-and-one-name rule
for this strip: two controls in a title bar cannot both carry a word, and the search's field already
says what is filtering. The search button is a **disclosure**, not a toggle: `aria-expanded` marks it
and `aria-controls` names the field it opens, the `Button`'s own expanded plate gives it the selected
look, and closing it puts the focus back on it rather than leaving it on the body. A query with matches keeps the field open while
it filters, and the empty state's *Show all* closes it. The matcher is unchanged: fuzzy, over a
session's title, its project's name and its branch, ranking a contiguous hit above a scattered one and
keeping the sort's order within a rank.

**The sort is the header's, and the projects keep their row.** The projects run under the field on
their own full width, nothing pinned over them and nothing measured for a dock.

## Considered options

- **Keeping the field in the bar and adding the sort beside the icon anyway.** Then the bar holds the
  title, the field, the sort and the icon at a phone's width, and the field is the one thing in it
  that needs the room.
- **A sort menu that opens from the title.** The list's other screens sort from a button with the
  same mark and the same menu (`SortMenu`), and one control in one place is what keeps them in step.
- **Leaving the projects' row as ADR 0093 drew it, minus the dock.** The chips would still be
  crowded by a control that belongs to the bar above.

## Consequences

- `routes/code.tsx` draws the header as title, then search, then sort — `SortMenu` compact, its
  trigger the arrow alone. The search button is named *Search*, is the search glyph whether its field
  is open or shut, and carries `aria-expanded` with `aria-controls`, which names the field only while
  that field is mounted. The field is `SearchField` (taking an `id` for that pointer), drawn in the
  list's own column above the projects, and closing it returns the focus to the icon.
- The dock, the `--dock` measurement and the `data-slot="sort-dock"` mark are gone; nothing measures
  the chips' room in JavaScript.
- `scripts/e2e/code-list.mjs` proves the two signs share the bar at its own gap, search first and the
  pair ending on the bar's right edge; that the sort carries no word; that the search stays the
  search glyph and reads as pressed while its field is open; that no dock is drawn; and that the
  field opens under the bar while the title stays visible and the projects stay under the field.
