# Spec: a subagent's delivery stays out of the thread

Docs already updated in this session (uncommitted): `GLOSSARY.md` (**Subagent result** redefined, **Wake turn** added), `AGENTS.md` (delivery-row sentence), `docs/adr/0052-a-subagents-delivery-is-not-a-message-in-the-thread.md`.

## Problem Statement

When a background subagent finishes, the thread draws its result as a bot message at the thread's end. It lands mid-turn, so it sits pinned under a reply that is still streaming, and it can appear and then disappear after the next catch-up. The finding already lives in the subagent's card and sub-thread, so the thread says it twice, in the wrong place.

## Solution

The thread draws no message for a subagent's delivery. A finished subagent's findings are read in its sub-thread, from its card or the subagent sheet. The wake turn the host starts afterwards stays fully visible: when the main run has ended and waits on a subagent, the wake turn is the main run continuing, with its reply, tools, questions and approvals drawn as any turn's. Only the wake prompt (the model's input) draws nothing, as today.

## User Stories

1. As a user, I want nothing pinned under a reply that is still streaming, so that the thread reads in the order the work happened.
2. As a user, I want a subagent's finding in its sub-thread, so that it is read in one place.
3. As a user, I want the subagent sheet to show a finished subagent as Finished with its sub-thread one tap away.
4. As a user, I want a message to never appear and then vanish, so that I can trust what I read.
5. As a user whose main run stopped to wait on a subagent, I want the wake turn's reply to show as a normal continuation, so that I see the work carry on.
6. As a user, I want a question asked inside a wake turn to replace my composer, so that the bot is never stuck waiting for me unseen.
7. As a user, I want an approval raised in a wake turn to surface the same way.
8. As a user, I want the wake prompt text never shown as my message.
9. As a user with chats from before this change, I want old result bubbles gone without losing my messages or replies.
10. As a user on a second device, I want the same thread, since nothing here is device state.
11. As a user reading a chat where several subagents finished, I want no stack of result bubbles, with the count and cards still in the subagent line and sheet.
12. As a maintainer, I want the glossary to say a Subagent result is never a thread message, so that it is not reintroduced.
13. As a maintainer, I want the wake turn's follow path (`adoptRun`) unchanged in timing, so that the #573 question bug does not return.

## Implementation Decisions

- The history fold treats a delivery row as bookkeeping: it draws no message, starts no turn and closes no reply (as now), and is not carried into the turn's results.
- The per-turn results plumbing in the catch-up merge and the `subagent` field on a stored message are removed along with the code that drew a result as a bot message; helpers with no other user go too. The host-side parsing the sub-thread/cards need stays.
- The wake turn path is untouched in behaviour. `adoptRun` still follows the newest reply after the last user message; its subagent-skip filter becomes unnecessary. The wake reply's write order and time must not change, because `adoptRun` compares that time with the run's start.
- Local data: stored messages that carry a subagent marker are deleted once (Dexie version bump or a one-off sweep on catch-up). No migration of user data.
- No plugin or API change. `MIN_PLUGIN_VERSION` is unchanged.
- Docs: ADR 0052 and the glossary entries (done).

## Testing Decisions

- A good test drives behaviour at the thread: what is drawn, in what order, whether a gate surfaces. It does not assert internal fold shapes.
- Seam: the existing component seam, the chat screen over a seeded device database with the HTTP boundary faked (`test-wake-question.tsx`'s harness). One seam covers every case; the pure fold test (`test-subagent-results.mjs`) shrinks to the rule that a delivery draws nothing and starts no turn.
- Prior art: `test-wake-question.tsx`, `test-wake-prompt.mjs`, `test-subagent-result.tsx`, and the `question-during-delegation` e2e.
- The #573 regression guard: `test-wake-question.tsx` must pass unchanged, plus a case with a delivery row before the wake turn: the question still raises and the delivery draws nothing.
- Rewrite the assertions in `test-subagent-result.tsx` and `question-during-delegation` that expect a result bubble; keep their question and wake-turn assertions.
- Sweep: `pnpm e2e question-during-delegation` (not `all`).

## Out of Scope

- Hiding or restyling the wake turn.
- Plugin or API changes, including how the wake is posted.
- Adding a result summary to the card or sheet.
- The unexplained "appears then goes" flicker, if it survives the change (see Further Notes).

## Further Notes

- The disappearance was not reproduced (no `node_modules` in this worktree). The working explanation is that the delivery row, written mid-turn and re-put by each catch-up, is the item that flickered. Ticket 3 confirms it.
- Run the usual gates before commit: lint, typecheck, test, build.

# Tickets

Order: 1 → 2 → 3. Each is one conventional commit; labels `ready-for-agent`.

## 1. refactor(chat): draw no thread message for a subagent's delivery

Blocked by: none.

- The history fold skips delivery rows as messages; they still start no turn and close no reply.
- Remove the `subagent` message field, the results plumbing in the catch-up merge and the message-item rendering; delete helpers with no remaining user.
- One-off cleanup of stored messages carrying the marker (bump the Dexie version; existing data keeps loading).
- Acceptance: a transcript with a delivery row draws no bubble; sub-thread, cards, the subagent line and the sheet still work.
- Tests: rewrite the bubble assertions in `test-subagent-results.mjs` and `test-subagent-result.tsx` to "draws nothing, starts no turn".

## 2. test(chat): a wake turn's question still surfaces with a delivery before it

Blocked by: 1.

- Keep `test-wake-question.tsx` unchanged and passing.
- Add a case: a delivery row in the transcript before the wake turn; the clarify form replaces the composer and the delivery draws nothing.
- Confirm `adoptRun`'s timing check is unaffected (the wake reply's time is unchanged by the change).
- Update `question-during-delegation` to stop expecting a result bubble while keeping its question and wake assertions; run `pnpm e2e question-during-delegation`.

## 3. test(chat): nothing pins under a streaming reply when a subagent finishes

Blocked by: 1.

- Reproduce the report first: a flow where a subagent finishes while another turn streams. Assert that no extra message appears under the streaming reply and that no message disappears across the catch-up.
- If the wake reply itself still flickers after ticket 1, record the cause and fix it in `adoptRun` without changing the question path from ticket 2.
- Update `docs/e2e-flow-audit.md` if a flow is added or changed.
