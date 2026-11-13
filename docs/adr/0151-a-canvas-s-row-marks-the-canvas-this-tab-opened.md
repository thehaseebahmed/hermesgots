# A canvas's row marks the canvas this tab opened

A pinned canvas was a `NavLink`, so the router decided its mark: wherever the address sat under
`/canvas/:id`, the row was filled and read `aria-current="page"`. A reader who pressed a pinned row,
followed a link, reloaded on a canvas, or stepped back or forward onto one was told a canvas was open
that they had never opened — and a screen reader said "current page" for it, on a page they had
merely arrived at.

**Only the canvas flow opens a canvas.** The list's tile press and a start write the canvas into the
tab's memory, and one predicate — the canvas on screen, and this tab opened it — decides the row's
fill and its `aria-current`. Every other way onto a canvas leaves the sidebar at rest. The flag is
the tab's and nothing is stored on the device, so a reload, a shared address and another tab all
arrive with no canvas open: each is a new document, and none of them is an opening.

## Where the two halves live

The flag is written in exactly two places, both the flow's own open (`routes/canvas.tsx`): the tile a
reader presses, which asks `plainPress` first so a press meant for a new tab opens nothing in this
one, and the arrival of a canvas a start made, which has no press to ask about.

It is forgotten in two places. The app shell forgets it when the app leaves the canvas's screens,
which is what makes back and forward onto a canvas mark nothing. A pinned row's own press forgets it
too, because that press is a way onto the canvas like any other and no open — so a reader standing on
a canvas it opened, and pressing that canvas's row, is given a row at rest. Leaving that to the shell
alone would make the mark depend on how deep the history was: a top-level move lands on the list on
its way to the canvas, and the same press would be an arrival or not depending on where the reader
started. The shell is the host for the rest rather than the sidebar, because the sidebar is a phone's
drawer and a drawer that is shut runs no effect — and because a mark is the app's answer, not the
list's.

The route decides *whether* a canvas is on screen, and the flag decides *whether this tab opened
it*. Both halves are needed: the flag alone would have to be trusted for its own timing, and the
route alone is the bug. The route half is exactly the two screens the app draws — the preview and the
edit screen — so an address under a canvas's name that no screen claims is no canvas to the mark.

Canvas's own section row is made exact on the way: a canvas's screens mark the canvas's row and not
the section it lives in, since a row's mark says *this is the one drawn here* (ADR 0146) and two rows
cannot both be it. A canvas nobody pinned has no row, so a canvas opened through the flow marks
nothing at all — which is the same rule as a list that marks no row over an open chat.

## What the reader is told

| The reader | The sidebar | A screen reader |
|---|---|---|
| presses a pinned canvas's row | the row at rest, even the row of the canvas it just opened | "A pinned timetable, link" |
| lands on a canvas by a link, a reload or another tab | no row marked | each row a plain link |
| goes back or forward onto a canvas | no row marked | as above |
| opens a pinned canvas through the flow | its row filled | "A pinned timetable, link, current page" |
| opens an unpinned canvas through the flow | no row marked | the Canvas row is a plain link |
| presses Edit on a canvas it opened | the row stays filled | "…current page" |
| stands on `/canvas` | the Canvas row filled | "Canvas, link, current page" |

## Considered options

- **The route alone.** No state to keep, and no way to tell an opening from an address, which is the
  bug.
- **A store that survives navigation** (Dexie, `localStorage`). Another tab and a reload would keep
  the mark, so the tab that never opened the canvas marks it, and a canvas this device only visited
  stays marked for as long as the row exists.
- **A distinct route** (`/canvas/:id?opened=1`, or a `/view` suffix). The address would carry a fact
  about one tab's history: a share, a bookmark and a reload would all claim an opening nobody made,
  and every in-family `replace` — Edit, Preview, a point pick — would have to thread the parameter
  through six call sites or lose the mark.
- **A route's own `state`** (`navigate(to, { state: { opened: id } })`). Per-entry and per-tab by
  construction, and no store at all — but a browser keeps an entry's state across a reload, so a
  reload would go on marking; and the canvas's own `replace` moves would drop the mark while the
  canvas is still on screen.

## Consequences

- A reload loses the mark though the canvas is still on screen, and a second tab marks nothing. Both
  are the point: the mark is what this tab opened, and a reload is a new document.
- A canvas opened from its chat's row (`/c/:id` → `/canvas/:id`, ADR 0113) marks nothing, since a
  chat's row is no part of the Canvas flow.
- Moving between two canvases' screens without leaving them keeps the tab's flag naming the first,
  so returning to it by back marks it again even though nothing was re-opened. The flag is only
  forgotten by leaving the canvas's screens or by pressing a pinned row.
- A canvas's own chat row (`/c/:id`) draws no chat — it replaces itself with the canvas — so a reader
  who opened a canvas and then pressed that chat's row lands back on the canvas with the mark gone.
  The app made that exit, not the reader, but the state it lands on is the one an address gives, and
  the flow did not open it a second time.
- Canvas's section row no longer marks a canvas's screens, which is a visible change beyond the
  pinned row: it is what "the sidebar at rest" means on an address.
