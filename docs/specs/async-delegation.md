# Delegation that never blocks a question

Status: grilled 2026-10-23, every decision settled and recorded in ADR 0038. Published as #464,
whose children #465–#471 are the build order.

## Goal

A bot may ask its user anything while its subagents work. `delegate_task` returns a handle instead of
parking the turn, so the question — or any approval — is raised and drawn the moment it exists, and
the subagents carry on beside it. A finishing subagent's work re-enters its bot's thread as its own
message and wakes the bot to read it.

That is the whole feature. A turn with no delegation, and a thread with no subagent, change not at
all.

## What this is not

- **Not child-asked questions.** A subagent still cannot ask; it reports findings and its bot asks on
  its behalf (Hermes blocks `clarify` for delegated agents).
- **Not an upstream change.** The wake is posted by the plugin itself. An upstream Hermes capability
  (completions routed to core's wake path) is deferred, per ADR 0038, and would only let the plugin
  delete code later.
- **Not cross-device adoption.** A run this device didn't start is still only re-attached while this
  screen is idle; a pending question on it already surfaces through the waiting surface.
- **Not keyless hosts.** The app supports none: every bot has an API key and every run it starts is
  keyed, which is the case core already dispatches in the background.

## Decisions

1. **The plugin's synchronous-delegation override is deleted** (`plugin/delegation.py`, from commit
   e17f28e). Core already dispatches `delegate_task` in the background for a keyed `/v1/runs` turn
   and hands back a handle; the turn continues, and a `clarify` or approval in that same turn
   executes immediately. No prompt of any kind waits behind running work.
2. **A subagent's result lands as its own message at the thread's bottom, in arrival order**,
   attributed to the bot, tapping through to its sub-thread. Core writes the completion as a
   transcript row (`display_kind: async_delegation_complete`); the app must draw that row as the
   bot's message — today `history.ts` folds it into a *user* bubble, which is a bug this fixes.
3. **A finishing subagent wakes its bot.** The plugin watches the subagent sessions it already reads
   (they carry `parent_session_id` and `ended_at`) and, when one ends, posts a run on the parent
   session through the outbox — the loopback route AFK already posts runs with — carrying the
   result, so the bot reads it and may act, without the user writing again. The wake is posted once
   per subagent: an idempotency key derived from the subagent's session id, and a mark on that
   session once one is posted, so a plugin restart resumes without doubling.
4. **A wake is deferred while the user is being asked something.** Never post one while a question or
   approval is pending on the session — a completion must not cross a confirmation gate (the rule
   core states for exactly this). It posts once the control settles.
5. **A workflow stage waits for its subagents.** A stage does not advance until its run ends *and*
   every subagent that run started has ended, so a gate never reads a tree its build's subagents are
   still writing. No wake ever fires on a stage session: a stage keeps its one run.
6. **A session whose subagents are still at work reads as working**, whether or not a turn is live —
   the pill, the chat list and the run-reattach gating all read it that way.
7. **Stop halts the turn and its subagents.** Core detaches children before dispatch, so a run's stop
   no longer reaches them: the plugin fans the stop out to the subagent sessions of the run being
   stopped. Once the turn has ended, each subagent is stopped from its own card.
8. **Subagents are named from the glossary**: subagent, subagent result, sub-thread.

## Where it lives

| Path | What it is |
| --- | --- |
| `plugin/delegation.py` | The override deleted; the subagent watcher, the wake posting and its deferral, the stop fan-out, the stage hold |
| `plugin/outbox.py` | Unchanged — the loopback post the wake uses, with its idempotency key |
| `plugin/__init__.py` | The stop-a-subagent route; `sync_delegation` no longer advertised in `info` |
| `plugin/sessions.py` | The mark on a subagent's session that its wake has posted, and children's liveness once the parent's run is over |
| `app/src/lib/history.ts` | `async_delegation_complete` drawn as the bot's own message with the subagent id behind its tap-through, never a user bubble |
| `app/src/lib/agents.ts` | A subagent counts as running while it runs, not only while its parent's run is live; the stop call |
| `app/src/components/chat/agent-card.tsx` | Stop on the card, once the turn that started it has ended |
| `app/src/lib/chat.ts`, `app/src/lib/workspace.ts` | The session-state rule: working while any subagent runs |
| `app/scripts/mock-hermes.mjs` | A delegation whose child ends mid-chat, and a clarify raised while it runs |
| `app/scripts/e2e/question-during-delegation.mjs` | The flow, with its row in `docs/e2e-flow-audit.md` |
| `plugin/tests/test_delegation.py` | Rewritten: background dispatch, wake deferral, stage hold |
| `docs/adr/0038-a-question-never-waits-behind-a-subagent.md` | The decision |
| `GLOSSARY.md` | **Subagent**, **Subagent result**, **Sub-thread**, **Question**, **Approval**; **Session state** amended |

`plugin/README.md` and `AGENTS.md` describe the sync override today; both are rewritten with it.

## Edges

- **Two subagents finish together**: one wake each, deduped per subagent by its idempotency key;
  the host serialises the turns.
- **A subagent fails**: its result carries the end reason, and the wake still fires so the bot reads
  the failure.
- **A question is pending when one ends**: the wake waits for the answer (or the question's expiry)
  and then fires.
- **The host restarts mid-delegation**: daemon subagents die with it; their sessions end up with no
  `ended_at` and no live parent, which already reads as stopped. The stage hold treats a stopped
  subagent as ended; the gate is what catches incomplete work.
- **Compression**: children already span compression continuations (`delegation.children` walks
  them), and the wake run resolves the compression tip on the host, like any run.
- **A run that somehow arrives unkept-keyed**: core keeps that turn's delegation synchronous —
  accepted, since the app keys every run it starts.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit (plugin)** — `test_delegation.py`: dispatch no longer forces `background: False`; the wake
  is posted once per ended subagent with a stable idempotency key and skipped for a marked one; no
  wake while a question or approval is pending; a stage does not advance while its run's subagents
  run; the stop fan-out names every live subagent of the run.
- **Unit (app)** — `test-history.mjs`: a delivery row draws as the bot's message with its subagent
  id, not a user bubble; a row before this change's rows still loads. `test-workspace.mjs` (or
  wherever `sessionState`'s rule sits): working while a subagent runs with no live turn.
- **Component** — an agent card whose turn has ended offers Stop and stops its subagent; a subagent
  result message taps through to the sub-thread.
- **End to end** — `scripts/e2e/question-during-delegation.mjs`: the test host's bot delegates, the
  child still running, the bot asks — the question card replaces the composer *now*, not at the
  child's end; the child finishes, its result lands as the bot's message at the thread's end, and
  the wake turn streams. The argument for the tier is the composer-replacement timing and the
  arrival-order landing across a live stream.
- A row and a verdict in `docs/e2e-flow-audit.md`; `scripts/test-e2e-registry.mjs` fails without one.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Then
`pnpm e2e question-during-delegation`, `pnpm e2e stream-writes`, `pnpm e2e idle-requests`. From the
root: `python3 -m unittest discover -s plugin/tests -t .`.

## Tickets

On the tracker: #464 is the spec, and its seven children are the build order — each titled the
commit that lands it, each blocked by the tickets its edges name. The spec carries
`ready-for-agent` and the tickets stay bare, so AFK claims the spec and works the whole graph,
ticket by ticket, in order.

1. #465 `feat(chat): draw a subagent's result as the bot's message` — the transcript-drawing rule,
   its unit test. Edge: none. Lands first so a host already delegating can never show a user bubble.
2. #466 `feat(plugin): let delegations run beside the turn` — the override deleted, the rewritten
   delegation tests, `sync_delegation` unadvertised, README and AGENTS.md. Edge: #465.
3. #467 `feat(plugin): wake the bot when a subagent finishes` — the watcher, the outbox post, the
   deferral, the session mark, the stop-a-subagent route. Edge: #466.
4. #468 `feat(plugin): stop a turn's subagents with it` — the stop fan-out. Edge: #466.
5. #469 `feat(plugin): hold a stage until its subagents end` — the AFK stage hold. Edge: #467.
6. #470 `feat(chat): read a session working while its subagents run` — the state rule and the
   card's Stop. Edge: #467, #468.
7. #471 `test(chat): prove a question during delegation` — the mock's delegation, the flow, the
   audit row. Edge: #465–#470.

## Risks

- **A new plugin with an old app** draws results as user bubbles until the app updates (the PWA
  updates itself; an APK lags). Mitigated by the build order: the app's drawing rule ships first and
  tolerates a host that never sends the row.
- **A wake costs one model turn per finished subagent**, and several finishing together queue behind
  the session's concurrency cap. Accepted in the grill; the cost is the same turn the old
  synchronous path spent blocking.
- **The plugin now owns wake dedupe** that core's registry would have given free — idempotency keys
  plus the session mark cover restarts and double-runs; the upstream capability in ADR 0038 remains
  the path to deleting this code when hosts allow it.
- **A subagent that never ends** (a host that lost it without ending the session) would hold a stage
  forever; the liveness rule already reads a child of a dead parent as stopped, which is what lets
  the hold finish.
