# A sort is a key and a direction

**Amended by [ADR 0095]: the control shows one sign, not three.** What a sort *is* — a key and a
direction — stands as written below; what the control *reads* changed. The up/down pair icon is gone
and the direction arrow stands where the key's name begins, before it, so the trigger is one sign and
one name.

Every list in the app that sorts itself offers a menu of flat choices, and half of those choices are
a direction wearing a key's clothes. Code says *Created*, *Last activity*, *Title A–Z*; the Library
says *Newest*, *Oldest*, *A–Z*, *Z–A*; the sidebar's bots say *Recent*, *Waiting*, *Name*, *Added*;
the model picker says *A to Z*, *Price*, *Context*, *BenchLM Score* and decides the direction inside
`SORT_ASC`. So the reverse of every sort is either a second item in the menu (the Library's) or not
offered at all (Code's, the bots'), and a reader who wants the oldest session first has no control
that says so.

**One shape: a key and a direction.** A sort is the fact the list ranks by — `created`, `activity`,
`title`, `name`, `price`, `waiting` — plus an ascending or descending arrow. The menu lists the keys,
once each; the row that is already the choice carries an arrow at its end instead of a checkmark, and
tapping that row again flips the arrow and closes the menu, while tapping another row picks it at
the direction that key reads best in (newest first for a date, A to Z for a name, most waiting
first, cheapest first for a price). The trigger names what the list is sorted by and shows the same
arrow, so the direction is readable without opening anything.

**One control draws it.** `SortMenu` already replaced three hand-rolled copies; it now owns the
direction as well, so a list cannot offer the arrow on one screen and a checkmark on another. The
paired choices collapse: the Library's four become *Newest* and *Name*, the bots' four keep their
keys and gain a direction, Code's three gain a direction, and the model picker's per-key `SORT_ASC`
becomes each key's own default arrow.

## Considered options

- **Add the arrow and the toggle, keep every existing choice.** The Library would list *Newest*,
  *Oldest*, *A–Z* and *Z–A* beside a toggle that duplicates two of them, and the two ways of saying
  "oldest first" could disagree.
- **Offer direction only where the key is a number.** Names sort both ways just as meaningfully, and
  a list that reverses one day and refuses the next reads as a bug.
- **Keep the direction out of what is stored and derive it from the key.** Then a pick cannot
  remember the arrow the reader chose, and the list reopens the way the code decided.

## Consequences

- The stored sort is a key plus a direction: `botSort`/`botSortDir`, `codeSort`/`codeSortDir`,
  `librarySort`/`librarySortDir`. A value written by an older build — `new`, `old`, `az`, `za` — is
  read as the key and arrow it meant, so a device keeps the order it had on its first open after
  the change.
- The model picker's list is the one sort with no persisted direction: it is a sheet's own order,
  reopened with each row's default arrow.
- `scripts/test-sort.mjs` pins the default arrow per key, the flip on a second tap, and the reading
  of an older stored value.
