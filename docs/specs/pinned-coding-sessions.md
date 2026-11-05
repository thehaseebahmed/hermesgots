# A session can be pinned above the Code list's status groups

Status: grilled 2026-11-05, every decision settled and recorded in
[ADR 0103](../adr/0103-a-pinned-session-stands-above-the-four-groups.md). Built in the branch that
carries this file; no tickets.

## Goal

A reader who works in the same two or three coding sessions all day can pin them, and they sit in a
**Pinned** band at the top of the Code screen whatever their status does underneath. The band is
above **Waiting for You**, so a pinned session is the first thing on the screen rather than the last
thing under a heading that moved. The row keeps its state colour and glyph, so a pinned session still
says whether it is working, waiting or at rest, and the band is the reader's own placement rather
than a claim the list worked out.

## What this is not

- **Not a status group.** The four groups answer which claim holds a session; the band answers where
  the reader put it. `codeGroups` gains the band as a prepended group and the four keep their
  vocabulary, membership and order.
- **Not a sort key.** The band runs the same order as every group, so the sort control keeps one
  meaning; nothing about the band is stored per device.
- **Not a mirror.** A pinned session leaves its group, so the list still draws one row per session.
- **Not a second list.** Only the Code screen has the band. The sidebar's session lists, the project
  screen's session list and the closed-session screen keep the order they have.
- **Not a protection.** Cleanup still sweeps a session with nothing in it; a pin is a place, not a
  keep-alive, and it does not stop a close, a resolve or a discard.
- **Not capped, and not hand-ordered.** There is no ceiling on how many sessions may be pinned and no
  drag to arrange them; the sort control orders the band like any other group.
- **Not a state that expires.** A pinned session that falls to Idle or Closed stays in the band.
- **Not read state.** Nothing about the unread dot, the read marks or last activity changes.

## Decisions

1. **A `Pinned` band is drawn above the four, read from the session's own `pinned` flag.** It is the
   first group `codeGroups` returns and it is dropped when empty, like the four (ADR 0103).
2. **A pinned session leaves its status group.** `codeGroups` filters pinned rows out of the four
   before folding them, so the band and the groups never hold the same session and every header's
   count is a count of rows drawn under it.
3. **The band runs the list's own order.** It is handed the same `codeOrder` comparator as every
   group, so created, last activity and title mean the same thing in the band as below it, and pin
   time is not an order the reader can see or change.
4. **Filtering drops the band.** A search query or a project chip already replaces the groups with one
   flat sorted list; the band goes with the headers, so filtering stays one rule rather than two
   (ADR 0046, decision 7).
5. **`pinned` is the session's own flag, and it travels.** A boolean on the conversation, read as
   "is this pinned" wherever it is set, added to `CHAT_FIELDS` so it syncs through the chat record the
   way `muted` does — no Dexie version, no index, no plugin change, because a chat value is opaque
   JSON on the host. It is no moment: unlike a project's `pinnedAt`, nothing reads when it was
   pinned, because the band follows the list's sort.
6. **The marker is a glyph in the row's line.** A pin icon announced as "Pinned" sits at the start of
   the row's second line, copied from the project list's row, so a pinned session is recognisable in
   the flat filtered list where the band is not drawn.
7. **The toggle is a row in the session's options menu.** Beside Mute, over the session it applies to:
   an `ItemRow` cannot carry a trailing control without nesting one interactive element inside
   another, and the tree has no long-press or context menu to hang one on.
8. **Pinning is one write.** The toggle sets `pinned`, and unpinning clears the field, through
   `updateConversation` — which stamps `changedAt` and leaves `updatedAt` alone, so the row's trailing
   time and last activity do not move.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/lib/item-groups.ts` | The band's key and label, and `codeGroups`' pinned predicate that lifts rows out of the four |
| `app/src/routes/code.tsx` | The list, the band's call site, the row's pin glyph |
| `app/src/components/chat/chat-actions.tsx` | The Pin / Unpin row in the session's options menu |
| `app/src/lib/db.ts` | `pinned` on the conversation |
| `app/src/lib/sync.ts` | `CHAT_FIELDS`, where the pin travels |
| `app/src/components/item-list.tsx` | `ItemGroup`, which takes a `ListGroup`; and `pinnedLine`, the mark both lists draw |
| `app/scripts/test-code-groups.mjs` | The band's membership and order, the four groups unchanged |
| `app/scripts/e2e/code-list.mjs` | The flow: the band drawn, a pinned session counted above the four |
| `docs/adr/0103-a-pinned-session-stands-above-the-four-groups.md` | The decision |
| `GLOSSARY.md` | **Pinned**, and **Pin** qualified as the model |

## Edges

- **Pinning a session that waits on the reader** — it leaves **Waiting for You**, so that header's
  count falls by one while the band above it grows. The row keeps the warning tone and the alert
  glyph.
- **Pinning the only session in a group** — that group disappears, exactly as an empty group already
  does; the band takes its place at the top.
- **Pinning a closed session** — it sits in the band above **Closed**, drawn with its check or archive
  glyph, and the list still refuses to read its pull requests or transcript tail (ADR 0088).
- **Searching with sessions pinned** — the band is not drawn, the flat results run the chosen order,
  and a pinned row is told apart by its pin glyph.
- **A project chip** — same as a search: the band is dropped, because the chip's list is already
  filtered output.
- **Two devices** — a pin written on one arrives on the other through the chat record; a device
  saving an older copy of that record clears it, the same last-writer-wins cost `muted` carries.
- **A session deleted while pinned** — the pin goes with it; nothing holds a pin for an id that is
  gone.
- **390px** — the band, its header count and the row's glyph hold at phone width; nothing here is
  tablet-only.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit** — `app/scripts/test-code-groups.mjs`: the band is first and dropped when empty, a pinned row
  is absent from its status group, the band follows the comparator it is handed, and the four groups'
  order and counts are unchanged when nothing is pinned.
- **Component** — `app/scripts/test-code-rows.tsx` draws a row directly; the pin glyph is asserted
  there, in the row and not in the list.
- **e2e** — `app/scripts/e2e/code-list.mjs`: `ORDER` gains **Pinned** so the helper stops filtering the
  band out, and the flow pins a session from its options menu and asserts the band appears above
  **Waiting for You** with that session in it.
