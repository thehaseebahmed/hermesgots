# The Code list is arranged by status, coloured by what's needed, and dotted where unread

Status: grilled 2026-10-24, every decision settled and recorded in ADR 0046. Published as #530 with
tickets #531, #532, #533, #534, #535 and #536; the build order at the end is the tickets' shape when
implementation starts. #530 is blocked by the gate issue #537 that this docs pull request (#529)
closes — work starts on that merge. The spec carries `ready-for-agent` and the tickets stay bare, so
the agent claims the spec and works the graph in order.

**Revised 2026-10-25 — the primary claim inverts.** ADR 0053 supersedes decision 2's ordering: a run
in flight claims the row, so **Working** holds every session something runs for, and **Waiting for
You**, **Idle** and **Closed** hold only sessions nothing runs for. The waits still win among
sessions nothing runs for — a question, an approval, a plan review, a host's stall, a pull request's
checks running or failing — and an approval or a question still reads as a wait while the run is
blocked on it, since `waiting_for_approval` is the run not running. Everything else this spec
settled stands.

**Revised 2026-10-25 — the dot needs a mark.** Decision 5's "no mark means unread" inverts (ADR
0055): the dot shows only where this device holds a read mark and the session's last activity is
newer than it, so a session this device has never opened draws no dot at all. The mark stays local,
is still written by rendering the thread, and the comparison against last activity is unchanged;
what goes is joining an absent mark to that comparison at zero. Everything else this spec settled
stands.

## Goal

The Code list arranges itself by session state instead of by when a session was last touched, so the
sessions waiting on the user sit at the top regardless of recency. Four groups in fixed order —
**Waiting for You**, **Working**, **Idle**, **Closed** — each under a sticky header with a count,
empty groups dropped, Closed always collapsed with Resolved and Discarded inside it told apart by
their icon. The row's round state icon carries the colour that says what is needed (yellow for a
wait on the human or a pull request's checks, green for Resolved and an open pull request needing
nothing, grey for everything at rest), while the glyph inside keeps saying why. A blue dot at the
icon's top-right marks a session whose thread has had activity since this device last rendered it,
and never a session this device has not opened, which has no "since" to be after; the time at the end
of the row is that thread's last activity rather than its last turn's end.

## What this is not

- **Not the sidebar's lists.** The chat lists, the Waiting-for-input section and the bot threads keep
  their ordering and presentation; scope is the Code screen alone.
- **Not a new date vocabulary elsewhere.** The date buckets leave the Code list only; no other screen
  groups by them today's way or the new one.
- **Not synced read state.** Read marks live on one device and never enter the chat fields or sync;
  nothing about this change adds a schema or a merged field.
- **Not a new icon.** There is no per-project avatar; the colour lands on the round state icon the
  row already draws, and the bot's art tucked in its corner is untouched.
- **Not the pane's auto-open rule.** Which session opens beside the list stays last-opened else most
  recently active non-closed — a list ordered by status must not decide what the reader was reading.
- **Not review-approval data.** The pull request payload carries no review decision, and none is
  fetched for this; approvals means the session's own approval card.
- **Not green for everything good.** Merged and closed pull requests are grey: green names an open
  pull request or a resolved session and nothing else.
- **Not the implementation.** This spec, ADR 0046 and the glossary entries are what this change ships
  first; the build is the six tickets below, once the pull request carrying this file merges.

## Decisions

1. **Status beats recency; created breaks ties.** The four groups run Waiting for You, Working,
   Idle, Closed, and inside every group sessions run created, newest first, so the order is
   deterministic rather than a live timestamp chasing itself (ADR 0046).
2. **Membership is the highest claim.** Resolved or discarded is Closed; otherwise any wait on the
   human — question, approval, plan review, host stall, or a pull request's checks running or
   failing — is Waiting for You, beating an agent that is also running; otherwise Working; otherwise
   Idle. Checks running therefore moves from Working to Waiting for You, while a session holding an
   open pull request awaiting review keeps the place it has today.
3. **Colour says urgency; glyph says cause.** Precedence, top rule wins: Discarded grey, Resolved
   green, wait-on-human or checks yellow, draft pull request grey, open pull request needing nothing
   green, Idle grey, Working grey. A draft that still owes an answer is therefore yellow, failed
   checks are yellow, and Working shares Idle's grey — the spinner is what tells them apart.
4. **Glyphs do not move.** Alert for a human wait, the pull request arrow wherever a live pull
   request is the story (checks running or failing included, since the second line already says so),
   spinner working, code idle, check resolved, archive-x discarded, lock for a removed repository.
5. **The dot is a read mark comparison, not a count.** Blue, in the info tone, at the icon's
   top-right corner: shown when last activity is newer than the moment this client last rendered the
   thread, and only where there is such a moment — no mark means no dot, never unread — live while
   the list is on screen, on any row including inside the collapsed Closed group, and written back
   by rendering the thread in the pane or on its own page.
6. **Last activity is derived, never stored.** The newest of the turn's end, the pull request's
   timestamps and the resolve/discard timestamps, worked out where it is drawn: no field joins sync,
   no Dexie write, and the trailing time keeps its format.
7. **One ordering rule with one escape hatch.** A sort-by dropdown picks created (default), last
   activity or title A–Z for every group, remembered per client; while a search query or project chip
   filters the list the headers drop away and the chosen order runs flat, so filtering is the list
   with its headers removed rather than a second rule.
8. **The guidance is corrected with the change.** The line saying a session whose checks are running
   groups as `working` says Waiting for You when this ships.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/lib/session-work.ts` | Where a session stands — its state, the group claim with a pull request's checks running or failed waiting, the last-activity derivation and the unread predicate |
| `app/src/lib/pull-state.ts` | A pull request's live states and its checks waiting, apart from the schema |
| `app/src/lib/item-groups.ts` | The four groups' labels and order, which group a state lands in, the fold both list vocabularies group by, and each group's orders |
| `app/src/routes/code.tsx` | The list, its headers, the trailing time, the dot, the sort-by dropdown |
| `app/src/components/item-list.tsx` | The row's icon colour, glyph and the dot's corner |
| `app/src/components/sort-menu.tsx` | The one sort control, which the sidebar's bots and the Library tree draw too |
| `app/src/lib/compare.ts` | How every list orders names |
| `app/src/lib/code.ts` | The list's sessions, read per project from the host |
| `app/src/lib/read-marks.ts` | Per-client session to last-rendered moments, dropped with the session |
| `app/src/lib/workspace.ts` | Reading a session's worktree and pull requests; `sessionState` re-exported for its callers |
| `app/scripts/test-*.mjs` | Unit rules: membership and order, colour precedence, last activity, unread |
| `app/scripts/e2e/`, `app/scripts/e2e/cli.mjs` | The flow that proves grouping, colour and the dot |
| `docs/e2e-flow-audit.md` | Its row and verdict |
| `docs/adr/0046-the-code-list-is-arranged-by-status-and-a-dot-marks-what-this-device-hasnt-read.md` | The decision |
| `docs/adr/0055-a-code-rows-dot-needs-a-read-mark-before-it-can-show.md` | The dot's one overturned sentence: no mark, no dot |
| `GLOSSARY.md` | **Last activity**, **Read mark**, and Session state's waiting amended |
| `AGENTS.md` | The checks-run-as-working line corrected |

## Edges

- **A question asked while a pull request's checks run** — the wait on the human is the higher
  claim, so the row is yellow with the alert glyph and the pull request arrow gives way.
- **A draft pull request with an open approval** — Waiting for You group, yellow icon: draft grey
  applies only when nothing waits.
- **Checks failing once settled** — still Waiting for You, yellow, pull request arrow; the
  difference from running is the second line's words, not the colour.
- **A merged pull request on a session nobody resolved** — grey, and in Idle or Working like any
  other session; green never means "merged".
- **Activity arriving while the list is open** — the dot appears live and the time moves, without a
  reload and without a Dexie write (read marks are local, last activity is derived).
- **Opening a thread in the pane** — the mark is written where the thread is rendered, so pane and
  page behave as one rule and a second device keeps its own dot.
- **A session this device has never opened** — no mark, so no dot; creating a session lands on it,
  which writes the baseline, and any session's mark arrives the first time its thread renders here.
- **Searching with the dropdown on title A–Z** — headers drop and the flat results run A–Z; the same
  choice governs grouped and filtered views.
- **390px** — the four groups, colours and dot all hold at phone width; nothing here is
  tablet-only.
- **The code-sessions and panes flows** — they assert the list still lists, and opens; their
  expectations may need to move with the new grouping.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit** — membership and group order, the colour precedence, the last-activity derivation and the
  unread predicate are pure rules over plain inputs: the tier where they can be driven exhaustively,
  following the repo's existing pure-rule scripts.
- **Component** — a row rendered over a seeded device database for colour, glyph and dot as drawn,
  which a pure rule cannot see.
- **End to end** — the dot's corner placement and the grouped layout are geometry, which no DOM
  without layout proves: one flow at 390px and a tablet width, light and dark, with its registry row
  and its audit row.
- **The flows this change touches**, run individually by name: the code sessions regression, the
  panes flow and the screens sweep.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then the flows the change
touches, each run by name rather than through the nightly registry (ADR 0029).

## Build order

1. #531 — feat(code): arrange the Code list by session state. Edge: none.
2. #533 — feat(code): show a thread's last activity as its row's time. Edge: none.
3. #532 — feat(code): colour the Code row's icon by what's needed. Edge: 1.
4. #534 — feat(code): dot a session this device hasn't read. Edge: 2.
5. #535 — feat(code): order each Code group by a sort-by dropdown. Edge: 1, 2.
6. #536 — test(code): prove the Code list's grouping, colours and unread dot. Edge: 3, 4, 5.

## Risks

- **A colour rule silently outranking another** is the failure mode nobody spots in review: the
  precedence is one table and carries unit tests that walk the collisions (draft vs waiting, open vs
  failing checks, merged vs resolved).
- **Read marks leaking into sync or Dexie** would wake live queries and merge across devices; they
  are deliberately local-storage facts, and a reviewer should see no schema bump with this change.
- **Existing flows assert today's grouping**, so the code-sessions, panes and screens flows may need
  their expectations moved in the same ticket that changes the grouping, not left red for the test
  ticket to absorb.
- **A stale guidance line** (checks running grouping as `working`) would contradict the shipped
  behaviour; it is corrected with the change, listed in Where it lives.
- **The dot's dot-vs-badge collision** — the AFK badge and the bot's corner art share the row — is
  why the dot is pinned to the icon's top-right corner rather than the row's corner.
