# A bot or thread switch holds the old chat and lands the new one whole

Status: grilled 2026-10-24, every decision settled and recorded in ADR 0048. Published as #539
with tickets #540, #541, #542 and #543; the build order at the end is the tickets' shape when
implementation starts. The spec carries `ready-for-agent` and the tickets stay bare, so the agent
claims the spec and works the graph in order.

## Goal

Switching bots or threads lands as one change. The chat pane holds the chat you left — its last
ready frame — until every answer for the chat you asked for has arrived for the id being shown,
then lands the new chat's header and body in one commit. No frame in between is ever drawn: no
setup copy, no "New chat" title, no new-chat hero over a half-loaded body, no scroll jump. While
the hold is on the pane is inert, so no tap or send can reach the wrong chat. With nothing to hold —
a cold start or a deep link — the body shows a spinner under the kept header. The ready line shows
only on a chat that is genuinely unstarted, so a switch burns no line turn and swallows no greeting.
The shell's fade stays, but plays at the swap rather than at the navigation.

## What this is not

- **Not a change to what a chat shows once ready.** The message layout, the composer, the header's
  subtitle and the empty states' own contents are untouched; this changes which of them a switch
  passes through, not what they say.
- **Not a hold on the sidebar.** The selection moves the moment the user taps; only the panes hold.
  Selection is feedback, the pane is content.
- **Not a loading placeholder per switch.** The hold is the previous chat itself; the spinner
  exists only where there is nothing to hold yet.
- **Not a change to the greeting.** Its wording, rotation and hourly timing are as they were; a
  switch simply never mounts it.
- **Not synced state or a schema change.** Nothing new is stored; no Dexie version moves.
- **Not other screens' transitions.** Code, Routines, Settings and the Android shell keep the
  transitions they have.
- **Not glossary vocabulary.** "Ready" and "hold" are working words for this behaviour and stay out
  of GLOSSARY.md, whose "Ready task" and skill `Ready` already own those words elsewhere.
- **Not the implementation.** This spec, ADR 0048 and this file are what this change ships first;
  the build is the four tickets below, once the pull request carrying this file merges.

## Decisions

1. **Ready means every answer names the id being shown.** Settings, the conversation, its profile
   and the messages must all have answered — and, on a Main thread with bot threads on, Main's
   thread list too. The flag is composed over the live queries that already read the chat; their
   ranges and their stale-answer guards stay exactly as they are, and an answer naming another id
   never renders. Once a chat is ready for an id, a transient query gap never pushes it back to the
   hold.
2. **Every answer is three-state** — unknown, answered-empty, answered. An unknown profile is never
   read as "not configured"; an unanswered thread list is never read as "no threads". This is what
   kills the wrong empty states at the root rather than papering over them (ADR 0048).
3. **The hold is the previous chat's last ready frame and the swap is one commit.** At 1280px and
   up both panes hold; below that the routed chat holds. The held frame is the last ready one and
   does not stream forward, since the queries already answer for the new id.
4. **The hold is inert by design.** The composer is hidden or disabled and taps do nothing until
   the swap: a send during the hold must never reach the outgoing chat, and never a chat whose id
   the send path would have to guess.
5. **Ready covers the device's own answers only.** A transcript fetch from the host keeps the
   spinner it already shows after the swap — a network wait never holds the pane. A conversation
   answering "definitely gone" is an answer, not a gap: it counts as ready and renders the honest
   empty state for it.
6. **Nothing to hold shows a spinner.** A cold start or a deep link has no previous frame; the body
   shows a spinner under the kept header until the first ready frame, and the setup copy is never
   painted as a loading state.
7. **The ready line mounts only on a genuinely unstarted, ready chat.** A switch therefore consumes
   no line turn and swallows no greeting; the storage keys a switch touches are none.
8. **The first content frame is the final scroll position.** Main's thread cards are part of what
   the chat waits for, so the scroller moves once and nothing pushes the content around after it.
9. **The fade plays at the swap, not at the navigation.** Navigation into a bot or thread switch is
   silent — a fade at that moment fades in the held content, which is the flash the hold exists to
   remove. Push, back and other screen changes keep their transitions; reduced motion keeps
   everything still (ADR 0048).

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/routes/chat.tsx` | The ready flag over the chat's live queries, three-state answers, the hold, the one-commit swap, the inert controls, the cold-start spinner |
| `app/src/lib/threads.ts` | The thread list's three-state answer and the thread-list half of the ready gate |
| `app/src/lib/greeting.ts` | The ready line, mounted only where a chat is unstarted and ready |
| `app/src/components/app-shell.tsx` | The pane keys the hold has to survive, and the transition retimed to the swap |
| `app/src/components/ui/message-scroller.tsx` | The single first scroll, with the content final around it |
| `app/scripts/test-*.tsx` | The component test: the frame sequence across a switch, and the untouched greeting keys |
| `app/scripts/e2e/bot-threads.mjs`, `app/scripts/e2e/cli.mjs` | The frame-sampling steps folded into the bot-threads flow |
| `docs/e2e-flow-audit.md` | The flow's row, gaining what the new steps assert |
| `docs/adr/0048-the-chat-pane-holds-the-previous-chat-until-the-next-one-is-ready.md` | The decision |

## Edges

- **A switch while a reply streams** — the held frame is the previous chat's last ready one and
  does not animate forward; the swap still lands in one commit when the answers are in.
- **A switch to a chat whose transcript must be fetched** — the device answers, the swap lands, and
  the fetch keeps its spinner; the hold never waits on the network.
- **A thread deleted on another device, then opened here** — the conversation answers "gone", the
  chat counts as ready, and the honest empty state renders under the real title.
- **A cold start on a deep link** — nothing to hold, spinner under the kept header, then the first
  ready frame; the setup copy never shows.
- **Bot threads off, or below 1280px** — the same gate and hold on the one chat surface the shell
  shows; the thread list is simply not part of the gate where it does not exist.
- **Two rapid switches** — the stale guards stand: an answer naming the first switch's id never
  renders for the second, and the hold shows the last ready frame throughout.
- **Reduced motion** — the same content changes with nothing animated; the fade and any slide are
  suppressed exactly as they are today.
- **A chat with messages but no cards, or cards but no messages** — readiness waits for both on a
  Main thread with bot threads on, so neither state is ever drawn alone.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Component** — the switch driven over a seeded device database with the host faked: change the
  id under the chat and assert every render carries either the previous chat's ready frame or the
  new one — never the setup copy, the "New chat" header or the ready line in between — and that the
  greeting and line-turn keys do not change. The render sequence is external behaviour here, which
  is why it does not escalate.
- **End to end** — paint and geometry only, which a DOM without layout cannot prove: frames and
  scroll positions in a real browser. The steps fold into the bot-threads flow — no new registry
  key, the stay count untouched — and its audit row says what it now asserts.
- **The flows this change touches**, run by name: `pnpm e2e bot-threads`, and the stream-write and
  idle-request budgets stay green.
- **Measurement** — the switch's settle time on production builds, before and after, with the
  numbers in the pull request.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then `pnpm e2e bot-threads`
by name rather than through the nightly registry (ADR 0029).

## Build order

1. #540 — feat(chat): hold the chat until its answers are in. Edge: none.
2. #541 — fix(chat): scroll a switched-in chat once. Edge: 1.
3. #542 — feat(ui): play the page fade at the swap. Edge: 1.
4. #543 — test(chat): prove a switch paints no intermediate state. Edge: 2, 3.

## Risks

- **The hold misread as a frozen app.** On a slow device the previous chat can sit for a beat; the
  inert controls make that beat safe but also static, and the spinner covers only the case with
  nothing to hold. If the hold ever reads as a hang, the fallback is the neutral blank pane the
  grill rejected, not a spinner per switch.
- **The remount keys fighting the hold.** The panes are keyed today, so every switch is a fresh
  mount; the hold has to outlive it. A test that mounts the switch the way the shell does — the
  component test's job — is what catches a hold that works only in isolation.
- **A three-state answer read back as two.** The whole fix rests on "unknown" never meaning "empty";
  any new read of these queries must keep that distinction, and the frame invariant is what fails
  if one slips.
- **The fade retiming regressing real transitions.** Push, back and other screens keep theirs; only
  the same-surface swap moves. A screen that loses its entrance animation is a bug in the retiming,
  not a trade-off.
- **The frame steps slowing the flow.** They sample during switches that already happen in the
  bot-threads flow; if they make the sweep heavy, the sampling window narrows rather than the steps
  dropping.
