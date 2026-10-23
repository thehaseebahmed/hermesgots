# Interfaces: aligned with the text, drawn for data, drawing maps

Status: grilled 2026-10-23, every decision settled and recorded in ADR 0039 and ADR 0040. Published as
#487 with tickets #488, #489 and #490; the build order at the end is the tickets' shape when
implementation starts. #487 is blocked by the gate issue that the docs PR carrying this file closes —
work starts on that merge.

## Goal

A reply's interfaces sit where the reply's text sits, the model draws its data instead of typing it
out, and its places draw as a map. Three things are wrong today: a drawn block doesn't line up with
the text around it and clips its chart labels; the prompt that teaches the model still answers
questions with "text only" and names components the library doesn't have, so data arrives as prose;
and places can't be drawn at all. Doing the three together is what keeps the instructions inside
their one measured budget.

## What this is not

- **Not interactive components.** The library stays read-only: no actions, no forms, no queries. The
  map is interactive as a view — pan and zoom — never as an action.
- **Not geocoding.** The model supplies coordinates; no service resolves place names.
- **Not map routes or regions.** Labeled points only; paths and choropleths wait for demand.
- **Not a second prompt section.** One artifact, one section, one measured budget (ADR 0040).
- **Not a change to the media gallery or the tool group.** They keep their own insets.

## Decisions

1. **A drawn interface's box takes the text's inset.** The wrapper carries the same inset the reply's
   text and the block's undrawn code form carry, so nothing shifts when a block starts drawing.
   Inside the box the chart keeps its normal axis insets, sized so tick labels never clip; the gap
   around a block is the thread's paragraph gap, one uniform value.
2. **Data draws; conversation speaks.** An answer shaped like data — numbers, a series, a comparison,
   locations, structured facts — draws an interface; opinions and one-liners stay text.
3. **A question is asked, never drawn.** The agent's question for the user goes through the clarify
   tool where the host offers one — the thread already draws its question card — and falls back to
   text. The old "questions get text only" rule is replaced, not amended.
4. **The artifact is compressed and its generated body is rewritten** (ADR 0040): the build script
   owns it end to end, the prose goes compressed, and every signature, enum value and rule string
   stays byte-exact against the schema. Every regeneration reports length, headroom and delta.
5. **The map takes labeled points** — latitude, longitude, a label, an optional detail — and a
   required summary like the chart's, because a reply may be read aloud.
6. **The map draws on interactive tiles** (ADR 0039): real basemaps, theme-aware, the provider's
   attribution in its chrome.
7. **Touch passes through an untouched map.** One finger always scrolls the thread; a tap activates
   pan and zoom, and a visible affordance hands gestures back.
8. **The map's heavy code rides the lazy boundary** like the chart's surface, and the chunk gate
   learns its marker.
9. **Three sequential changes**: the alignment fix, the prompt rewrite, then the map that spends the
   headroom the rewrite leaves. Each regenerates the artifact at most once.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/components/openui/openui-block.tsx` | The wrapper's inset and the gap around the block |
| `app/src/components/chat/message-item.tsx` | The block's place among the reply's parts |
| `app/src/components/openui/chart-surface.tsx` | The axis width that stops tick labels clipping |
| `app/scripts/build-openui-prompt.mjs` | The artifact's rewrite and compression; the measured numbers |
| `plugin/openui/prompt.txt` | The artifact regenerated |
| `app/src/components/openui/map.tsx`, `map-surface.tsx` | The map component and its lazy surface |
| `app/src/components/openui/library.tsx` | The map's registration and the child union |
| `app/scripts/check-openui-chunks.mjs` | The chunk gate's map marker |
| `app/scripts/test-openui.tsx`, `app/scripts/test-openui-prompt.tsx` | The component cases and the artifact's gates |
| `app/scripts/e2e/openui.mjs`, `docs/e2e-flow-audit.md` | The geometry proofs and their rows |
| `docs/adr/0039-a-map-draws-with-interactive-tiles.md` | The map's decision |
| `docs/adr/0040-the-prompt-artifact-is-compressed-and-rewritten.md` | The artifact's decision |
| `GLOSSARY.md` | **Interface** amended; **Block** and **Patch** recorded |

## Edges

- **A five-digit tick at phone width** — the axis width is fitted to the labels it carries, not to a
  constant, so no label clips at any width.
- **A map with one point** — the view still fits and pans; a single marker doesn't break the bounds.
- **A map streamed mid-reply** — an open block draws what it can; the summary and markers draw while
  tiles arrive.
- **A host with no clarify tool** — questions fall back to text; nothing else changes.
- **The interface switch off** — every block stays the text it arrived as, map included.
- **Tiles unreachable** — markers and summary draw over an empty grid; an interface that can't draw
  at all stays the text it came from.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Component** — each component renders and each required prop is proven required (the chart's cases
  are the prior art); the map draws its points and reads its summary as its accessible name.
- **End to end** — geometry is what jsdom cannot prove: alignment, label clipping and the gesture
  contract go to the browser sweep, phone and tablet widths in light and dark, each flow with its row
  and verdict in `docs/e2e-flow-audit.md`.
- **The artifact's gates** — drift, size, the named fence, the app's rules and the version pin; the
  plugin's bound assert stands.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then
`node scripts/check-openui-chunks.mjs` and the flows the change touches. From the root:
`python3 -m unittest discover -s plugin/tests -t .`.

## Build order

1. #488 — A drawn interface lines up with the text around it. Edge: none.
2. #489 — A data answer draws as an interface and a question asks through clarify. Edge: 1.
3. #490 — A reply draws its locations as a map. Edge: 2.

## Risks

- **The budget is the schedule.** The rewrite must leave the headroom the map spends; the bar is 300
  characters measured the spec's way. If compression can't free it, prose goes before schema
  (ADR 0040).
- **Tiles are a network dependency** the thread didn't have: an offline map holds its markers over an
  empty grid. Accepted in the grill (ADR 0039).
- **A prompt reaches new sessions only** (ADR 0032): chats already open keep their frozen
  instructions until they start again.
- **Compressed prose is terser for humans too**: the drift test pins the artifact byte for byte, so
  every regeneration is deliberate, but reviewers read compressed English.
- **Tile terms travel with the choice**: attribution and the provider's usage policy are part of the
  contract now; a busier future may need a keyed provider.
