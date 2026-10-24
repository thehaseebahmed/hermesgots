# Cards fill the chat's pane while the thread keeps its reading column

Status: grilled 2026-10-23, every decision settled and recorded in ADR 0041. Published as #493 with
tickets #494, #495, #496 and #497; the build order at the end is the tickets' shape when
implementation starts. #493 is blocked by the gate issue that the docs PR carrying this file closes —
implementation starts. The spec carries `ready-for-agent` and the tickets stay bare, so the agent
claims the spec and works the graph in order.

**Revised 2026-10-24 — the width rule inverts.** ADR 0046 supersedes this spec's Solution in its
width alone: a card never passes the reading column's 768px box (`CARD_BASE` is `COLUMN_BOX` plus
the surface), and centres inside it on a wide pane, where this spec's pane-fill would have taken it
to the pane's edges. The goal — one rule every in-chat card follows, with the split widths gone —
is unchanged, and so is everything the grilling settled about the mechanics: the pane as the
container, the column as the box's own 736px of text, the gutter on the container, the caps that
come off. What a card does at 1440px is the opposite of what Decision 1 says below: it stops at
768px and frames the text column by the box's 16px gutter each side. `card-widths` measures the cap
where this spec's Tests section asked it to measure the fill.

## Goal

Every card Gots draws for itself inside a chat fills the chat's pane with the thread's 16px gutter,
while message text and the composer keep the 768px reading column they have today, and a card's
contents stretch with its card. Three things are wrong now: the subagent's card and the answered
question card stop at 448px inside a reading column that is itself only 768px wide; the live Question
that takes the composer's place stops at 768px while the pane it is asked in is far wider; and one
thread can show three card widths at once, with the same Question at two of them. Below about 800px
the pane and the column coincide, so the phone is untouched by construction rather than by a special
case.

## What this is not

- **Not a wider reading column.** Message text, thinking, the composer, the header and the pill row
  keep the widths and positions they have.
- **Not the thread's other furniture.** The rows a tool group draws (576px) and the media gallery
  (42rem) keep their own caps; neither is a card.
- **Not the screens outside a chat.** The chats drawn as cards in a bot's Main thread and the cards
  on the Bots screen are untouched.
- **Not a reply's own blocks.** An interface the model drew is the reply's content, so it stays in
  the reading column.
- **Not popups, pills or banners.** A popup's width is its size; a subagent's work popup fills it
  today and keeps filling it.
- **Not the Question's buttons.** Skip, Next and Send keep their sizes, left-aligned in the wider
  footer — the one thing inside a card that does not stretch, decided in the grill.
- **Not the implementation.** This spec, its ADR and its glossary entry are what this change ships
  first; the build is the four tickets below, once the pull request carrying this file merges.

## Decisions

1. **A card fills the pane; text keeps the column.** The rule covers every card the app draws inside
   a chat — the subagent's card (pending and running), the live Question, the answered question card,
   the approval in both of its places, plan ready, plan approved, blocked, resolved and discarded —
   with the thread's 16px gutter.
2. **The reading column moves; the pane does not open up.** The thread's scroll content becomes the
   pane with its gutter, and each part that is not a card carries the column itself. The structure
   forces this: a thread's scroll items clip their paint, so a card cannot bleed out of the item it
   sits in (ADR 0041).
3. **The column is written so text does not move.** Its width is the 768px box's own 736px of text
   with the pane's gutters outside it, which lands message text on the same pixels at every width and
   keeps it aligned with the composer below.
4. **The gutter belongs to the container.** No card carries a width of its own, so the approval card
   needs nothing special in either of the two places it renders; the composer slot keeps the gutters
   it already has and its cards only lose their cap.
5. **Two caps come off.** The 448px cap on the cards drawn in a thread, and the 768px cap on the
   cards that take the composer's place; the per-card centring goes with them.
6. **Contents stretch with the card** — titles, step lists, status lines, choice rows — except the
   Question's footer buttons, which keep their sizes (Decision 4 of the grill's last round).
7. **A prefactor lands first.** The column moves onto the parts with no visible change (#495), then
   the caps come off (#496), so the structural change and the visible change are reviewed apart and
   each stays green on its own.
8. **The rule is recorded, not implied.** ADR 0041 says why a card is wider than the text beside it,
   and the glossary's **Card** says what the word means here — three unrelated things were called a
   card before this session, which is why the scope took two passes to pin down.
9. **One flow guards it.** Width is geometry, so it goes to the browser sweep (ADR 0019) with its
   registry row and its audit row.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/routes/chat.tsx` | The scroll content that becomes the pane, and the composer slot's cards |
| `app/src/components/chat/message-item.tsx` | Which parts of a reply carry the column and which do not |
| `app/src/components/chat/agent-card.tsx` | The subagent card's cap |
| `app/src/components/chat/session-cards.tsx` | The answered question and plan cards' cap |
| `app/src/components/chat/question-card.tsx` | The live Question card and its footer buttons |
| `app/src/components/chat/approval-card.tsx` | The approval, which renders in both places |
| `app/scripts/e2e/`, `app/scripts/e2e/cli.mjs` | The width proof and its registry row |
| `docs/e2e-flow-audit.md` | Its row and verdict |
| `docs/adr/0041-a-card-fills-the-chats-pane-not-its-reading-column.md` | The decision |
| `GLOSSARY.md` | **Card** recorded |

## Edges

- **A chat opened beside a list** — the card fills that pane, not the window: the gutter is measured
  from the pane the thread is drawn in.
- **A question answered** — both cards are full width of the container they stand in: the waiting
  one in the composer slot, the record in the thread. The thread reserves a scrollbar's gutter the
  slot keeps none of, so the record lands that reservation (10px with `scrollbar-thin`) narrower at
  the swap — each container's own gutters deciding, never a cap, as ADR 0041 records it.
- **An approval swapping with the Question** — both take the composer's slot at the same width, so
  the swap is not a jump.
- **A card arriving mid-stream** — it fills the pane from its first frame; a card never arrives
  narrow and then widens.
- **390px** — a no-op: the pane and the column are the same width there, so every card already fills
  the screen and keeps filling it.
- **The scrollbar's reserved gutter** — the card's width is taken from the pane's content box, so a
  wide card never sits under the scrollbar or pushes the thread.
- **A subagent's own work popup** — its cards fill it as they do today; popup widths are untouched.
- **A card at 1440px** — its contents stretch across a very wide card by decision, accepted rather
  than capped.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **End to end** — geometry is what no DOM without layout can prove: one flow measures a waiting
  Question card and a subagent's card against the pane at 390px and 1024px, and message text against
  the reading column at the wide width. Prior art is the flows that already assert behaviour at phone
  and tablet widths.
- **Nothing lower** — a unit or component tier would only assert the classes, which are not the
  behaviour; there is no rule here without layout.
- **The flows this layout touches**, run individually and kept green: the waiting question, the
  missed question, the approval, the screens sweep and the drawn interfaces.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then the flows the change
touches. Geometry never relies on the nightly registry run (ADR 0029): each flow is run by name.

## Build order

1. #494 — feat(chat): fill the composer slot's cards to the pane's width. Edge: none.
2. #495 — refactor(chat): move the reading column off the scroll content and onto each part. Edge: none.
3. #496 — feat(chat): draw a thread's cards at the pane's width. Edge: 2.
4. #497 — test(chat): prove a card fills the pane at phone and tablet widths. Edge: 1, 3.

## Risks

- **A 16px drift in the text column** is the failure mode nobody sees in review: the flow measures
  message text as well as cards, so the arithmetic is asserted, not eyeballed.
- **A card in a context without the pane's gutter** would touch an edge; the gutter lives in the
  container precisely so every context that draws a card supplies it.
- **Existing flows assert positions too**, so the screenshots and measurements of the screens and
  interfaces sweeps may need their expectations moved with the cards.
- **Content that clips paint** is why the first approach — a card bleeding out of the column — was
  abandoned; anyone reintroducing a bleed will find it cut off at the scroll item.
- **Wide cards at laptop widths** make card contents very wide; accepted in the grill as the plain
  reading of "contents stretch", with the Question's buttons the one deliberate exception.
