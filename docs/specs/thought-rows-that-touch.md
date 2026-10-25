# Thought rows that touch draw as one, and open until the answer

Status: grilled 2026-10-24, every decision settled and recorded in ADR 0049, which supersedes the
row-count, fold and cap clauses of ADR 0038. Amended 2026-10-25 by ADR 0051, which moves placement
alone: the stretches a tool group broke draw as one row above that group, not under it, so a tool row
never lands between two thought rows — every other decision here stands. Published as #547 with
tickets #548, #549, #550, #551 and #552; the build order at the end is the tickets' shape when
implementation starts. #547 is blocked by the gate issue #554 that the docs pull request #553
carrying this file closes — implementation starts once it merges. The spec carries `ready-for-agent` and the tickets stay bare,
so the agent claims the spec and works the graph in order.

## Goal

A thread that shows the same thought twice, with nothing between the two rows, reads as if the app
repeated itself — and it happens on the ordinary shape of an agent turn: two tool calls back to back
with no text between them draw as one group, and the stretch of thinking that followed each call
lands beside the other underneath it, so the two rows touch. The rows a turn opens while its thinking
streams also collapse a second later, the working-out is cut to a third of the screen behind a fade
and a Show more link, and a reader who wants quiet rows has no way to ask for them. Thinking is drawn
per reply as rows that merge when they touch, that stay open from the moment you watch them until the
answer begins, that show all their words when open, and that an Appearance switch can keep folded
from the start.

## What this is not

- **Not a change to runs.** A run stays one contiguous stretch of thinking between tool calls,
  anchored to the call that broke it, kept in arrival order, stored as it is today: no schema change,
  no migration, no change to how spans are carried. The merge happens where a reply's rows are drawn.
- **Not a change to tool grouping.** Calls that touch keep drawing as one group; no attempt is made
  to split them so each run sits under its own call.
- **Not a merge across replies.** Two replies in a thread each keep their own rows.
- **Not a host setting.** The switch is a device preference carried with the other Appearance
  switches, not something the host answers.
- **Not a summary.** The row shows the words it holds, in full; Claude-style summarised thinking is
  out of scope, and so is a bounded-height scrolling panel for long reasoning.
- **Not a remembered preference for taps.** A tap lasts the visit; the reload starts closed.
- **Not the implementation.** This spec, its ADR and its glossary entry ship first, in the docs pull
  request; the build is the five tickets below, once that pull request merges.

## Decisions

1. **Rows merge when they touch.** Consecutive placed parts of one reply that are both thought rows
   become one row, their stretches joined as paragraphs. A tool group, text, a card, media, an
   interface block, a steer or an approval between two rows keeps them apart, and rows in different
   replies are never merged.
2. **The merged row carries one label.** "Thinking…" while any stretch it holds still streams;
   "Thought for 12s" where this device measured every stretch, the spans added; "Thought it through"
   where it did not. One unmeasured stretch disqualifies the sum rather than reducing it, which keeps
   ADR 0038's honesty rule for a row that now holds several stretches.
3. **A row opens when you watch its thinking, and stays open until the answer.** Every row of a live
   turn stays open while the turn works and all of them fold together when the answer begins — or when
   the turn ends, if no answer comes. This replaces folding at each run's end, which closed a row
   seconds after it rendered.
4. **Storage rows start closed, and the tap lasts the visit.** A row drawn from a reload, a sync or
   an import is closed; a tap opens or closes it and nothing is written down, so the next load is
   closed again.
5. **The cap, the fade and Show more are gone.** An open row renders its whole markdown. The fold at
   the answer does the job the cap existed for — never pushing the answer off the bottom of a phone —
   and a reader who opens a finished row asked for it.
6. **The follow is untouched.** An open row tracks its newest words while its stretch streams, the
   reader scrolling up stops it, and a tap brings the row's end into view.
7. **One switch keeps it a preference.** *Fold thinking by default* in Appearance, off by default,
   carried in the settings document like the other appearance fields. On, nothing opens on its own —
   not even a streaming row — the footer's working line speaks while the turn thinks, and a folded
   row keeps its own "Thinking…" label.
8. **The decision is recorded, not implied.** ADR 0049 says why rows merge and when they open; the
   glossary's **Thinking** says what the unit is, and it stays *row* — *block* keeps meaning an
   interface block a reply carries.
9. **Geometry goes to the sweep.** Whether an open row is really uncapped is layout, so the
   thinking-line flow carries it with its registry row and its audit row (ADR 0019).

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/lib/thinking.ts` | The merge and the merged label as a pure rule, beside the run rules it reads |
| `app/src/components/chat/message-item.tsx` | Where a reply's rows are placed and merged into one another |
| `app/src/components/chat/thinking-line.tsx` | The row's open and fold, and the cap, fade and Show more coming out |
| `app/src/lib/db.ts` | The appearance field and its default |
| `app/src/lib/sync.ts` | The settings document record the field joins |
| `app/src/components/settings/appearance.tsx` | The switch's row |
| `app/scripts/test-thinking.mjs` | The pure rule's tests |
| `app/scripts/test-thinking-line.tsx`, `app/scripts/test-thread-rendering.tsx` | Placement, open and fold, the switch |
| `app/scripts/e2e/thinking-line.mjs`, `docs/e2e-flow-audit.md` | The geometry proof and its row |
| `docs/adr/0049-thought-rows-that-touch-draw-as-one-and-open-until-the-answer.md` | The decision |
| `GLOSSARY.md` | **Thinking** rewritten |

## Edges

- **A merged row that is still streaming** reads "Thinking…" for the whole row and grows as its
  newest stretch thinks; the fold at the answer then closes the one row, not two.
- **A partially measured reply** — where a transcript rebuild carried a span onto only one stretch —
  reads "Thought it through", never the measured half of the truth.
- **A steer or an answered approval** splits the reply into segments with the card between them, so
  rows on either side of the break are not adjacent and do not merge.
- **The switch turned on mid-turn** stops the next row from opening; rows already open stay open for
  the visit, since the switch governs what opens on its own, not what a reader opened.
- **A reply resumed after a dropped stream** still latches open — it is being watched on this visit —
  and still folds at the answer.
- **A reply stored before runs kept its thinking in one string** draws its single row at the top with
  nothing to merge with.
- **A delegated agent's sub-thread and a coding session's thread** draw through the same row
  component, so all three behave identically.
- **A long turn with the switch off** carries every stretch of the turn's thinking open while it
  works — accepted in the grill, bounded by the fold at the answer.
- **Performance**: a fully rendered open row grows with the words arriving, and the thread's
  memoized markdown blocks keep the finished part from being re-parsed; the streaming write budget
  flows guard it.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit** — the merge and the merged label as a pure rule with no DOM, prior art being the existing
  tests that drive the run rules without a screen: touching rows become one with their words joined,
  separated rows stay apart, every-measured spans sum, one unmeasured stretch reads "Thought it
  through".
- **Component** — a thread over a seeded device database with the HTTP boundary faked, prior art
  being the thinking-row component tests, one of which already renders back-to-back calls as a group
  with a row after each: placement of the merged row, the open latch and the fold at the answer,
  storage rows closed, the tap's visit-only toggle, the switch both ways, and a long open row showing
  its final words with no Show more control.
- **End to end** — the `thinking-line` flow, because an uncapped row is geometry no DOM without
  layout can prove: the merged row under the group, an open row's last words present, a folded row's
  hidden, at 390px and 1024px in light and dark, with its registry row and its audit row saying what
  it now asserts.
- **Existing expectations that move**: the fixture asserting three rows for back-to-back calls draws
  two, "one row per run" assertions become assertions about rows that touch, and fold timing
  assertions follow Decision 3.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then `pnpm e2e thinking-line`
by name — geometry never relies on the nightly registry run (ADR 0029). Streaming write and idle
request budgets stay green; the merge runs once per reply state, not per token.

## Build order

1. #548 — feat(chat): draw touching thought rows as one row. Edge: none.
2. #549 — feat(chat): keep a thought row open until the answer begins. Edge: none.
3. #550 — feat(chat): show an open thought row with no cap or Show more. Edge: none.
4. #551 — feat(settings): add the Fold thinking by default switch. Edge: 2.
5. #552 — test(chat): prove the merged, uncapped thought rows in the browser. Edge: 1, 2, 3.

## Risks

- **Three component tests assert the behaviour being changed** — three rows, "one row per run",
  fold-at-run-end — so they must be rewritten to the new expectations rather than loosened until they
  pass.
- **The latch must reset on a new visit**, or a stored row inherits openness from a previous mount;
  the failure is invisible in a single render and shows up only on remount.
- **The switch's default** changing to on would reshape every existing thread; it ships off.
- **The working line's suppression** was keyed on an open row existing; with the switch on it must be
  keyed on a row actually lying open, or the turn goes silent while it thinks.
- **A long turn leaves a long thread open** while it works; accepted in the grill and bounded by the
  fold, but worth watching in the streaming write budget.
