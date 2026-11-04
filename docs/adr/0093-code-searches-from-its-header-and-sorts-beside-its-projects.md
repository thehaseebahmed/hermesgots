# Code searches from its header and sorts beside its projects

The Code list kept two permanent rows of chrome above a list that is often three rows long: a full
search field, and a row of project chips. The field was the widest thing on the screen and did
nothing until it was typed in, and every session sorted from a menu in the header that sat a whole
row away from the projects the list is cut by.

**The search is a control in the header and a field where the title was.** A search button sits in
the header's top right, beside the sort; pressing it turns the header's title into the field, sliding
in from the button's side, and the list beneath it narrows as it is typed. Closing it — the button
again, the field's clear button, or leaving the screen — puts the title back and clears the query,
because a filter nobody can see is a list that is missing rows for no stated reason. The one
exception is a query with matches: it stays open while the filter is on, and the empty state's own
"Show all" closes it.

**The match is fuzzy.** A row matches when the query's letters appear in order anywhere in its
title, its project's name or its branch, so "authref" finds `auth-refactor` and "fix login" finds a
session whose branch is `fix-login-redirect`. Substring matches rank above scattered ones, and
within a rank the list keeps the order its sort gave it — a search narrows a list, it never
re-orders one.

**The sort moves beside the projects.** The project chips and the sort are one row: the chips scroll
horizontally from the left, and the sort button is pinned at the right end on a background of its
own, so a long project list passes *behind* it rather than pushing it off the screen. The row is
there whenever the list holds a session — a list with none has nothing to sort, and draws neither a
chip nor the sort — and the sort is never in the header beside the search.

## Considered options

- **Keep the field always visible and add the search button as a shortcut.** Two controls for one
  filter, and the field keeps the row of height this change exists to give back to the list.
- **Search only titles.** A session is found by what it is working on at least as often as by what
  it is called, and both are already on the row.
- **Fold the sort into the header on a wide screen and beside the projects on a phone.** One control
  in two places is two behaviours to keep in step, and the list's own row has space for it.
- **A regex or an edit-distance match.** Fuzzy here means forgiving of what the reader half-remembers
  — letters in order — not a query language nobody asked for.

## Consequences

- `lib/fuzzy.ts` is the matcher and the ranker, and `scripts/test-fuzzy.mjs` pins a subsequence hit,
  a scattered hit ranking below a contiguous one, and a miss.
- The list's field is `SearchField`, exported from `components/item-list.tsx` and drawn by both — the
  list's bar through `ItemSearch`, and Code's header, which animates it in place of the title. The
  chips run under the sort on a dock of their own, and the room they leave at the end is measured from
  that dock (`--dock`) rather than guessed at.
- `scripts/e2e/code-list.mjs` drives the button, the field, a fuzzy query and the chip row's sort.
