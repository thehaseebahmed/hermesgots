# The model picker's pop-up is one scroll

The model picker opens as a pop-up with a fixed height (`PICKER_HEIGHT`), and `PopupContent` wraps
its children in a single `Scroll` — one `overflow-y-auto` region for the whole sheet. For a while
the providers list inside carried a height cap of its own (`max-h-[14.5rem] overflow-y-auto
overscroll-contain`), so a host with more than four providers scrolled that list *within* the
pop-up's scroll: two nested scrollers over one surface. On a phone the inner list captures the
gesture first and, once it bottoms out, hands it to the outer one, so a single flick scrolls in two
stages and it is never obvious which list a swipe is moving. The cap had kept the Default and Recent
rows pinned above the providers; that pinned reachability is given up so the pop-up scrolls as one
surface and the providers list is as tall as its contents.

## Considered options

- **Keeping the cap on the providers list.** Rejected: it is the nested scroll being fixed. A list
  that scrolls inside a scrolling pop-up fights the finger — the inner scroller eats the gesture,
  then chains to the outer — and one surface that scrolls two ways is worse than one that scrolls
  once, however long it gets.
- **Pinning Default and Recent above the scroll**, so a long provider list scrolls beneath them with
  no nested scroller. Rejected for now: it moves those rows out of the list flow and is a larger
  layout change than removing the cap, and the common case — a host with a handful of providers —
  fits in the sheet without either.
- **Dropping the pop-up's fixed height** so it grows with its content instead. Rejected: the fixed
  height is what keeps the sheet from growing and shrinking between the picker's views (the
  providers, then one provider's models), which is its own kind of jump.

## Consequences

- A host with many providers now scrolls Default and Recent off-screen along with the providers. One
  scroll is the trade for no nested scroll, and search (`total > 8`) is the way past a long list.
- The MCP catalogue and server sheets keep their inner `overflow-y-auto` divs inside `PopupContent`'s
  own scroll. They are out of scope here, and their tabbed sheets may want an inner scroll by
  design; if they are ever fixed the same way, this record is the reason.
