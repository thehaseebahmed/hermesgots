# chat-next implementation plan

How the gaps in `docs/chat-next-parity.md` get closed, in the order they are built. The decision behind chat-next is `docs/adr/0065-chat-next-comes-into-the-app-behind-a-developer-switch.md`.

**Out of scope:** retiring the old screen (making `Settings.chatNext` the default and deleting `lib/chat.ts` / `lib/history.ts`). ADR 0065 makes that a later decision, taken when nothing the old screen does is missing. This plan only gets chat-next to that point.

Every step is one PR, stays behind the Developer switch, and passes `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. Each step's tests sit in the cheapest tier that would fail for the step's reason (ADR 0019); only geometry escalates to an e2e flow.

## Facts to confirm before step 2

The parity doc marks its request counts _derived_. Read in the code: `readTranscript` (`chat-next/api.ts`) pages 50 rows until a page comes back short, with no tip probe, and nothing under `chat-next/` uses `onChanges`, `useLive` or `watchChat`. The cost figure (about 44 requests in `idle-requests`' 65 s against a budget of 12) has not been measured.

## Steps

### 1. Baseline
Run `pnpm e2e idle-requests` and `pnpm e2e stream-writes` with chat-next on, and record the numbers in the step 2 PR. No code.

### 2. Cheaper reads and the change stream (blocks retiring)
- Probe the transcript's tip (one row) before reading, as `history.ts` does with `hermesTip`; read only rows newer than the newest held row.
- Grow the window backwards as the reader reaches the top, using the archive read already in `store.ts` (ADR 0058).
- Subscribe to `lib/live.ts` (`onChanges` / `useLive`) so a chat catches up when the plugin's stream says the session moved and polls only at `SAFETY_MS` while a stream is open.
- Tests: unit for the "what to read next" rule; component tests over a seeded device with the HTTP boundary faked, asserting a poll that finds nothing writes nothing and asks for one row; `idle-requests` back inside budget.

### 3. Thinking (blocks retiring)
- Stop `kept()` dropping `reasoning`; read it in `fold.ts`; handle `reasoning.available` on the run's events.
- Grow runs with `appendThinking` into `reasoningRuns`, draw through `thinkingRows` (ADR 0054, 0064).
- Tests: unit on the fold; component test that a transcript with reasoning draws thought rows.

### 4. Stop, approvals, questions (blocks retiring)
- Stop: add `stopSubagents` beside `stopRun` (`subagents_stop_all`, ADR 0051); pass `subagentsRunning` to the composer.
- Feed the app's `ApprovalCard` and `QuestionCard` from `Waiting`, answering through `respond`, in place of chat-next's bare cards.
- Give `ClarifyCard` the controls' `send` so Ask again stops writing rows through the old `sendMessage`.
- Tests: component tests for each card's answer path and the missed-approval case (`approval_not_pending` and friends).

### 5. Model pill and header options (blocks retiring)
- Pass `model` to the composer as `CurrentChatPage` builds it, including in the plan-ready card.
- Lift `actions` (rename, mute, resolve or reopen, discard, delete) and the context ring with its usage sheet out of `CurrentChatPage` into something both screens use.
- Tests: component tests for the pick being pinned at first send (`pinModel`) and each action.

### 6. Needed before default
In this order, one PR each unless two are trivially small:
1. Model-change and compaction dividers (pass `compactions`; `ModelChange`, `Compacted`).
2. Long chats: open on the newest `FIRST_ROWS` and draw the rest a beat later; replace the per-change `JSON.stringify` comparison in `shared` (`page.tsx`) with a cheap identity check. Escalates to an e2e flow (`bot-threads` holds the reader's place).
3. Interfaces: `useDraws` gives each row its `blocks`.
4. The limit banner above the composer.
5. The header's line (`sessionSubtitle`, reply count beside Main, a session centred).
6. Interim words (`message.interim`).
7. This device's own photos drawn from held bytes (`useMediaSources`).
8. Stats (`showStats`, tokens a second); needs something to measure them.
9. Following the reader (`FollowOnSend`, `FollowAfterApproval`).
10. Break reminders (`useBreakReminderEligibility`) and the dictation hint (title, project, repos).

### 7. One decision, no code
Record whether "a bot without the plugin's queue refuses a mid-reply message" stands. The plugin is mandatory, so it probably does; if so, mark the parity row as not a gap.

## Done when
Every row in `docs/chat-next-parity.md` is either built or moved to "Not gaps" with a reason, and the doc is updated in the same PR that closes each row.
