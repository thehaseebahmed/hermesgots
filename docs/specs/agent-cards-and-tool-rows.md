# An agent card is drawn only where a subagent was set to work, and control calls read as tool rows

Status: grilled 2026-10-25, every decision settled and recorded in ADR 0053. Published as #576 with
tickets #577, #578, #579 and #580; the build order at the end is the tickets' shape when
implementation starts. #576 is blocked by the gate issue #592 that this docs pull request (#583)
closes — work starts on that merge. The spec carries `ready-for-agent` and the tickets stay bare, so
the agent claims the spec and works the graph in order.

## Goal

A thread draws a subagent's card only where a call set a subagent to work — a `delegate_task` spawn —
and every other call reads as the tool row it is. The card used to follow the tool's name, so
`list`, `steer` and `stop` drew *Sub-Agent: list* over nothing, could adopt a subagent started
seconds nearby (the goal match needs eight characters; "list" has four), and left a chat polling its
session's agents for a delegation that never happened. What a call did is now worked out where its
arguments are in hand: the transcript as rows are read, the stream's own preview while the call
runs, and the stored label for rows written before this change — so past chats heal on their next
render with no migration. The thread then words each row by its action: *Listed subagents*,
*Steered subagent*, *Stopped subagent*; a pull request call as ship, push, update or status took it;
a cron call as its own action took it. The same call carries the same words while it streams and
after reload, a chat that never spawned anything stops polling for agents, and the thread's worst
case becomes hiding work briefly rather than inventing it.

## What this is not

- **Not a change to a spawn's card.** A real delegation keeps its card, its sub-thread, its result
  and its stop button, exactly as they are.
- **Not a change to the matching.** The goal match and its ±5s window are untouched; control calls
  simply stop reaching them, which is what removed the mis-adoption.
- **Not hiding control calls.** They are drawn — as rows, saying what they did.
- **Not a host or plugin change.** Everything derives client-side from what the app already
  receives, so any Hermes host version works and nothing cross-repo blocks the fix.
- **Not a migration.** No Dexie version bump and no backfill: the marker is a type-only field on
  stored rows, and rows that predate it classify from their own label.
- **Not the `tool_call` wrapper's live case.** A wrapped call isn't named by the live stream, so it
  reads as a row until catch-up reclassifies it; that is recorded in `fixes.md` with its reason.
- **Not a glossary change.** **Card** and **Subagent** already say what this enforces; the decision
  lives in ADR 0053 alone.
- **Not the implementation.** This spec, ADR 0053 and the deferred-fixes entry are what this change
  ships first; the build is the four tickets below, once the pull request carrying this file merges.

## Decisions

1. **The card follows the spawn, not the name.** One shared classifier answers "did this call set a
   subagent to work", asked by the thread's part split, the chat's agents-poll gate and the row's
   phrase table, so the three can never disagree (ADR 0053).
2. **A card requires positive proof of a spawn** — an absent `action`, `spawn`, or a `tasks` batch.
   Every other shape, recognised or not, draws a tool row: the thread's worst case is hiding work
   until catch-up, never claiming work that didn't happen.
3. **The proof is derived client-side, at ingest.** Transcript rows parse the call's arguments where
   they are in hand; the live stream matches Hermes's own control previews (`list`, `steer <id>`,
   `stop <id>`); catch-up re-derives authoritatively when the transcript lands. No projection change
   is asked of Hermes (ADR 0053).
4. **A row stored before this change classifies from its stored label.** Both of its shapes parse —
   the streamed preview and the transcript's JSON fallback — so old chats heal on their next render
   with no migration.
5. **One derived action serves labels and phrases.** Any tool call carrying an `action` carries the
   derived field, `delegate_task`'s label is built from it on both paths (ending the *list* versus
   `{"action":"list"}` mismatch), and the phrase tables key off the same derivation.
6. **The words say the action.** Control calls read *Listed subagents*, *Steered subagent*,
   *Stopped subagent*; pull requests ship → *Opened a pull request*, push → *Pushed the branch*,
   update → *Updated a pull request*, status → *Checked a pull request* (the legacy open-PR tool
   keeps *Opened*); cron's seven actions each read as the action they took. Each reads in the
   present while the call runs.
7. **The agents poll counts spawns.** A chat whose only delegation-shaped call was a control action
   stops polling the session's agents.
8. **Nothing else moves.** `PendingCard`, the goal match's window, subagent result cards and the
   stop button keep their behaviour; control calls just stop reaching them.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/components/chat/message-item.tsx` | The reply's part split: where the card-versus-row decision is asked |
| `app/src/lib/history.ts` | The transcript parse: the action stamp and the argument-derived label |
| `app/src/lib/chat.ts` | The live ingest: the control-preview match while a call streams |
| `app/src/lib/tools.ts` | The phrase table every row's words come from |
| `app/src/lib/agents.ts` | The agents-poll gate, now asked of the classifier |
| `app/src/lib/db.ts` | The marker as an optional field on stored rows — type-only, no Dexie bump |
| `app/src/components/chat/agent-card.tsx` | The cards themselves — unchanged, and where the decision stops applying |
| `app/scripts/test-*.tsx` | The component test: control call to row, spawn to card |
| `docs/adr/0053-a-card-is-drawn-only-where-a-subagent-was-set-to-work.md` | The decision |
| `fixes.md` | The deferred `tool_call` wrapper case, with its reason |

## Edges

- **A control call while it streams** — matched from the stream's own preview, drawn as a row at
  once, never as a pending card.
- **A row stored before the change** — no marker, its label parsed, drawn as a row (or its spawn as
  a card) on the next render; no migration runs.
- **A spawn with a goal shorter than eight characters** — still a card: the classifier keys off the
  action, not the goal text, which is what the old match could not do.
- **An action the classifier does not recognise** — a stamped call whose action is neither spawn nor
  a control draws a row, per the fail-toward-the-row default.
- **A `tool_call`-wrapped call** — a row while it streams (the projection carries no inner name),
  the correct drawing once catch-up rebuilds the turn; recorded in `fixes.md`.
- **A delegation inside a subagent's own pop-up** — the same classifier, so a card inside a card
  follows the same rule.
- **A spawn and a control call in one reply** — each draws where it happened: the card for the
  spawn, one row among the tools for the control.
- **390px and tablet widths, light and dark** — rows and cards keep the components they already
  have, so both hold at both sizes in both modes.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Component** — a reply seeded over a device database with the host faked, asserting a
  tool-group row and no agent card for a control-shaped call and a card for a spawn-shaped one,
  with the label-only legacy row and the streamed-versus-reloaded label agreement asserted in the
  same fixture. Prior art: the existing agent-card component tests.
- **End to end** — nothing here is geometry, so no new flow (ADR 0029); the flows that already
  exercise the chat thread run by name.
- **The plugin suite** — no plugin change, so it is untouched.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Nothing in `plugin/` moves,
so the plugin suite is not part of this change's gate.

## Build order

1. #577 — feat(chat): draw a delegation control call as a tool row, not an agent card. Edge: none.
2. #578 — feat(chat): say what a delegation control call did on its row. Edge: #577.
3. #579 — feat(chat): phrase a pull request call by the action it took. Edge: #577.
4. #580 — feat(chat): phrase a cron job call by the action it took. Edge: #577.

## Risks

- **A spawn's shape the stamp does not recognise.** If `delegate_task` gains an action that sets an
  agent to work, the fail-toward-the-row default would draw it as a row until the classifier learns
  it — a missing card, visible in review as a row where a card is expected, never a false card.
- **The legacy label parse drifting.** The fallback understands the two label shapes that exist
  today; a future change to either silently downgrades old rows to the row default. The component
  test pins both shapes.
- **The poll gate over- or under-counting.** The gate shares the classifier, including the legacy
  fallback, so a pre-fix chat that really spawned keeps polling while a list-only one stops; a gate
  that skipped the fallback would stop polling real delegations on old chats, which is why they are
  one rule.
- **Two actions phrased alike grouping together.** Rows group by their kind, so two actions sharing
  a phrase read as one group — the words above keep each action distinct on purpose.
