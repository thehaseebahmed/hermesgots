# A compacted chat's archived rows load as the reader reaches its top

A chat Hermes compacted in place shows only its live window: the app reads
`GET /api/sessions/{id}/messages?order=latest` without `include_compacted`, so the rows a compaction
archived never arrive and the thread starts at the summary. The host already answers that read —
`include_compacted` returns the compaction-archived history, one row per logical message, deduped by
the stored `display_order` so a turn a compaction carried forward under a fresh row id comes back
once, as the live copy, and the superseded original never comes back at all — but only by offset
(`after_id` is refused alongside it), and that offset counts display groups rather than raw live
rows. So the app asks for it, and only when the reader reaches for it.

The newest page stays the read it is today: the first page, the catch-up and `liveTurn`'s poll ask
for the live numbering, so opening a chat costs what it costs now. Reaching the top of a thread is
what asks for the rest: the app takes the next 500 rows above what it holds from the inclusive
numbering at offset 0, and reaches again until a page comes back short. There is no button — the
reach is the request, a quiet spinner sits above the oldest row while a reach runs, and a reach that
fails leaves the cursor as it was so the next reach carries on.

What a step keeps is decided by what the device holds, never by a row id: an archived row is any row
the display read returns that this device has no message for, kept in the order the host returned
them. The tempting rule — keep rows whose id is below the window's oldest id — is wrong, and a copy
of a real store says so: the display read orders by `display_order`, which parts ways with row ids
the moment a compaction re-emits a carried turn under a fresh one, so a chat of 3133 rows has an
archived row above the window holding an id newer than the window's own. Under the id rule that row
and its neighbour were dropped and never fetched again — a turn missing its reply, in the middle of
the conversation. So `olderThan` names which numbering the edge was found in — the live transcript,
whose offset counts its own rows, or the display read, which counts logical messages and is only
ever entered at its own newest end — and the archived walk ignores the id, counts itself in memory
for the length of one visit, and leaves no offset behind that a later read could mistrust.

The same rule set the sort: a step does not re-sort its rows by id, because the host's order *is* the
order — an id sort inverts whole stretches of a compacted chat — and it does not trim the page to a
turn start, because a drain runs to the chat's first row, where every turn is whole anyway. A page
that comes back short is the end. Pages go in front of one another rather than behind: the read
counts its offset back from the newest end but returns each page oldest first, so the page read first
sits nearest the window and every page after it is older. Stacking them instead reverses the archive
block by block, which no single-page chat can show — `pnpm e2e chat-archive` therefore seeds more
rows above the seam than one page carries and asserts the order they come back in.

The chat's `compactions` list says whether there is more: an empty list is the host saying the chat
was never compacted, so a short live page is the start and the cursor clears. The walk won't guess
when the list is unknown — a chat whose `compactions` was never read asks the plugin's context route
for it, once, at the moment the live transcript runs out, and that answer alone decides whether an
archived step runs. The probe it replaces was the cheaper design and it was wrong: on an
uncompacted chat the archived step read the whole transcript back and answered every row the device
already held, so the walk had to earn the same answer with a second dedupe against rows it had just
written. Asking costs one bounded request, on the one path where the answer matters, and the device
stays off it entirely until the reader reaches the top of a chat that has an archive. An answer and a
silence are not the same thing: a host that said the chat was never compacted clears the edge, and a
host that couldn't answer at all leaves the window where it was, because clearing on a failed read
would make the archive unreachable for good — nothing re-arms an edge that a reach threw away. The
reach also tries an unchanged edge twice before the reader has to leave the top and come back, so one
blip doesn't strand the archive behind an edge that never moves.

Archived rows are then kept on the device with the chat, like every other message, and nothing
evicts them; a chat the reader never reaches back into costs nothing.

A window an older version opened mid-turn is mended on the reach rather than left split: its first
message is a reply whose row belongs to a turn the live numbering's offset has already stepped past,
so the walk reads that turn whole and it replaces the cut part — the same mend `reconcile` makes for
a turn it catches up on. A reply this device streamed for a running turn names no row of its own, so
the catch-up that lands after it replaces it outright instead of writing a second one beside it.

Nothing of this change's own marks the window edge. A divider does stand there sometimes, and it is
the host's: `compactionMarks` places a compaction older than every loaded row above the first message
the device holds (`app/src/lib/compactions.ts`), because the rows it took away are off the transcript
and that top is the closest the app can get. This change only makes that approximation unnecessary —
the archived rows arrive and the same divider comes to rest where the compaction happened, with no
second one drawn — and it adds no marker of its own to say so.

## Considered options

- **Asking for `include_compacted` on every read** — one numbering, one cursor, one code path, and it
  was the tempting simplification. Rejected: `listSessionMessages` serves the open path, the
  catch-up's `limit: 1` probe and `liveTurn`'s poll as well as the loads, and the display read is a
  `GROUP BY display_order` that, on a session whose transcript spans a compression rotation (the
  route always sets `include_ancestors`), reads every row of every segment into Python and dedupes
  before slicing; on a store whose `display_order` predates the index it falls to the read-only
  rescan of the whole session. Three wasted requests on a rare path are cheaper than that on every
  open.
- **Loading the archive when the chat opens** — the thread whole from its first frame, no reach. Kept
  as the fallback if the drain proves slow. Rejected for now because opening a chat is the path the
  app protects hardest, and a phone on a train would pay for rows it never scrolls to.
- **Keeping the "Load earlier" button** — the smallest change, and an explicit affordance. Rejected:
  a chat whose archive is hundreds of rows deep is several taps into a conversation the reader is
  already reading backwards, and the button's own failure mode (a reach that stops) is handled
  better by keeping the cursor than by a control that means "try again".
- **Dropping the archived rows when the chat is left, or capping them** — IndexedDB growth. Rejected:
  a re-read costs the host the same display read, and a cap creates a hole in the middle of a thread
  that reads as if the chat began there.
- **A divider, or a line, at the top of the loaded window** — saying where the thread's edge is.
  Rejected: it explains the app's own plumbing, which `AGENTS.md` rules out, and it would sit
  against the compaction dividers that mean something the host recorded.
- **A client-side guard against a turn held twice** — skipping an archived row that matches a turn
  already on the device under another row id. Rejected: the host's display read is the definition of
  one logical message per row, and this device already re-points a carried turn at its new row id by
  content and time; a second rule would be guessing at what the host has already decided. What the
  change owes instead is a proof on a copy of a real store.
- **Storing the inclusive offset beside the live one** — cheaper reaches after the first. Rejected:
  a compaction between reads moves the whole numbering, so a stored offset can't be trusted, and the
  walk is one step on the largest compacted chat in this store (1982 archived rows, four 500-row
  pages), which is not worth state that can be wrong.
- **Probing the archive with one step instead of asking whether there is one** — no extra request:
  the display read is asked once, and an empty answer is the start. Rejected: on a chat that was
  never compacted that step answers the whole transcript back, so the walk pays a full display read
  to learn "nothing", and then has to dedupe against rows it only just wrote. A chat with no archive
  is the common case, and one bounded context read is cheaper than every one of them paying a
  display read.
- **Skipping the rows already on the device by matching a turn's text and time** — a second dedupe
  keyed on content. Rejected: the row id is the identity the host gives a message, and the device
  already stores it on every message it took from a transcript (`hermesRowId`), so the walk compares
  ids it holds — one rule, no content matching, and no re-write of a row that is already here.

## Consequences

- `loadEarlier` grows the archive step, and both numberings read the host's page cap of 500 — the
  live numbering included, since a step has no reason to ask for less than the window it is walking.
  Archived rows go through `toMessages` like live ones, so
  `hermesRowId` and `hermesAt` are filled and `compactionMarks` places dividers against the host's
  clock unchanged — one divider per compaction, with several in one gap still drawing one.
- Every message of a chat now lives on the device once the archive is in, and the thread's live
  query reads the chat whole: 3133 rows against 296 on the largest compacted chat in this host's
  store. `pnpm e2e stream-writes`, `pnpm e2e idle-requests` and a heavy chat's switch time are the
  budget; anything they can't carry is recorded in `fixes.md`, with splitting the read into a live
  window and a loaded archive as the escape hatch.
- `scripts/mock-hermes.mjs`'s `pageRows` learns `include_compacted` and its compaction keeps the
  archived rows instead of dropping them, and `pnpm e2e chat-archive` walks the drain in a browser:
  what only a browser can say is that nothing of the archive is on the device before the reader
  reaches the pane's top and all of it is after, which is a scroll offset and a thread's height — no
  DOM without layout has either, so the flow gets its row in `docs/e2e-flow-audit.md`.
- The proof on real data was run as a script over a copy of `state.db`, not a fixture: the largest
  compacted chat in this host's store (3133 rows, 296 live) opens on its 296 rows, reaches once for
  the 1982 archived rows above them in four pages, and ends with all 2278 display rows — none
  missing, none held twice, and the five dividers its six compactions draw anchored on the same
  messages a device holding the chat whole draws them on. The script reads a copied store, so it
  isn't committed; the flow above is what CI runs.
- The paging rule and the walk are a pure rule over `history.ts`'s helpers, driven by a `node --test`
  script; the draw over a seeded database is a component test.
