# chat-next implementation plan

**Status:** steps 2 to 8 are built on `ccr-eb6ef31a-3paja1` (step 1 was replaced by unit tests of the read, see `docs/chat-next-parity.md`, which lists what is closed and what is still to check).

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

### 3. The code face belongs to the agent's work only (done, built first)
Not a parity gap: a change to what chat-next already does. In a code session JetBrains Mono (`font-code`) should read only as the agent's own output, and nothing else in the UI.

**Today.** `routes/chat.tsx:502` puts `font-code` on the whole chat pane when `chat.projectId` is set, so the header, composer, pills, approval and question cards, and every card in the thread are in it. Sheets and drawers are portaled out of the pane, so they inherit nothing: a tool call's input and output (drawn with `font-mono`, which is not JetBrains Mono, in `tool-card.tsx` and `markdown-renderer.tsx`) never get the code face.

**Wanted.**
- In the face: the reply's text, the thinking rows' words, the tool calls' rows, and a tool call's input and output wherever they are drawn, including inside its sheet. Inline code and fenced blocks in a reply follow the same face.
- Not in the face: everything else, a sheet's title and other headings included, the header, the composer, the pills, the user's own bubble (assumed, to confirm), the day headings and dividers, and the cards for approvals and questions.

**How.**
- Drop `font-code` from the pane root. Keep `data-code-session`.
- A small context (`CodeFace`, provided where the page knows `projectId`) read by the components that draw the agent's output. React context crosses a portal, which a class on an ancestor does not, so the sheets that open from a tool group or a thought row get it without their heading ever being inside the scope.
- Apply `font-code` at the leaves that draw agent output (reply markdown, `thinking-line.tsx` and its sheet body, `tool-group.tsx` rows, `tool-card.tsx` input and output, the delegated agent's sub-thread transcript), and replace their `font-mono` with the code face when the context is on. The current screen has no `font-code` and stays as it is.
- `@fontsource-variable/jetbrains-mono` is imported in `chat-next/page.tsx`, so it already loads with chat-next's chunk. Nothing new ships at startup.
- Update the `AGENTS.md` Layout row that says a code session reads in JetBrains Mono.

**Tests.** Component tier, replacing `test-chat-next-mount.tsx`'s "a code session reads in JetBrains Mono": assert the code face on a reply, a thought row, a tool row and, with its sheet open, the call's input and output; assert it is absent on the header, composer, a sheet's title and the user's bubble; and that a plain chat has it nowhere. A DOM without layout can't measure the glyphs, so these assert the class and the context, not the rendered face.

### 4. Thinking (blocks retiring)
- Stop `kept()` dropping `reasoning`; read it in `fold.ts`; handle `reasoning.available` on the run's events.
- Grow runs with `appendThinking` into `reasoningRuns`, draw through `thinkingRows` (ADR 0054, 0064).
- Tests: unit on the fold; component test that a transcript with reasoning draws thought rows.

### 5. Stop, approvals, questions (blocks retiring)
- Stop: add `stopSubagents` beside `stopRun` (`subagents_stop_all`, ADR 0051); pass `subagentsRunning` to the composer.
- Feed the app's `ApprovalCard` and `QuestionCard` from `Waiting`, answering through `respond`, in place of chat-next's bare cards.
- Give `ClarifyCard` the controls' `send` so Ask again stops writing rows through the old `sendMessage`.
- Tests: component tests for each card's answer path and the missed-approval case (`approval_not_pending` and friends).

### 6. Model pill and header options (blocks retiring)
- Pass `model` to the composer as `CurrentChatPage` builds it, including in the plan-ready card.
- Lift `actions` (rename, mute, resolve or reopen, discard, delete) and the context ring with its usage sheet out of `CurrentChatPage` into something both screens use.
- Tests: component tests for the pick being pinned at first send (`pinModel`) and each action.

### 7. Needed before default
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

### 8. One decision, no code
Record whether "a bot without the plugin's queue refuses a mid-reply message" stands. The plugin is mandatory, so it probably does; if so, mark the parity row as not a gap.

## Done when
Every row in `docs/chat-next-parity.md` is either built or moved to "Not gaps" with a reason, and the doc is updated in the same PR that closes each row.
