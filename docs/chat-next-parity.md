# chat-next parity

What the current chat screen (`CurrentChatPage` in `app/src/routes/chat.tsx`, over `lib/chat.ts` and `lib/history.ts`) does that a chat drawn by chat-next (`NextChat`, `src/chat-next/`) does not yet. The current screen is retired (task 8) only once every row marked **Blocks retiring** is done. Audited 2026-10-29 against `ccr-b0990318-q2tg06`, by reading both screens. A finding marked _derived_ is worked out from the code rather than measured.

Fixed while auditing: chat-next's rows carried the Hermes session id as their `conversationId`, so a reply's `MEDIA:` tags never drew, a file's row couldn't download, and a missed question's Ask again found no chat (`30dd959`).

## Blocks retiring

| Area | Current screen | chat-next | Where to start |
| --- | --- | --- | --- |
| Transcript reads | `history.ts` probes one row (`hermesTip`), reads only what's new, and grows the window backwards as the reader reaches the top (ADR 0058) | `readTranscript` reads the **whole** transcript, 50 rows a page, on every poll: 2 s while busy, 15 s idle. A 500-row chat costs 11 requests a read, about 44 in the `idle-requests` flow's 65 s, against its budget of 12 (_derived_) | Probe the tip; read only from the newest held row; page backwards on reach |
| The change stream | `watchChat` and `useLive`: catches up when the plugin's stream says the session moved, polling only at `SAFETY_MS` while a stream is open | Ignores the stream, so it polls at its own pace whatever the stream says | `onChanges` / `useLive` from `lib/live.ts` |
| Thinking | A reply's thinking as rows (`thinking.ts`, ADR 0054, 0064), from the transcript's `reasoning` and the run's `reasoning.available` | No thinking at all: the store's `kept()` drops a row's `reasoning`, the fold reads none, and `reasoning.available` is ignored | Carry `reasoning` through the fold; `appendThinking` into `reasoningRuns` |
| The model pill | `ModelMenu` in the composer, and in the plan-ready card | `NextComposerBody` passes the composer no `model`, so a chat's model can't be changed | Pass `model` as `CurrentChatPage` builds it |
| The header's options | Rename, mute, resolve or reopen, discard and delete; the context ring and its usage sheet | `ChatHeader` with no `actions` | Lift `actions` and its dialogs out of `CurrentChatPage` |
| Back from a session or a thread | A back button to Code, or to Main; `setBackGuard`, so Android's back goes there too | A thread of Main leads back to it, guard included; a code session has no back button and no guard, so Android's back leaves the app from it | Lift `leave` and the session's guard |
| A session not started | Not drawn as a thread: the greeting and the repos it will work in (`EmptyState`), and leaving deletes it or asks to keep its draft | Opens on chat-next as an empty thread, since `route.ts` asks only that the chat has a record — a session started from Code has one before anything is sent — and leaving keeps it | Either check `updatedAt > createdAt` in the rule or draw `EmptyState` and lift `leave` |
| Stop | One press stops the turn and every subagent the session holds (`stopSubagents`, `subagents_stop_all`, ADR 0051); the composer offers Stop while a subagent works | Stops only the run it follows; the composer isn't told `subagentsRunning` | `stopSubagents` beside `stopRun`; pass `subagentsRunning` |
| Approvals and questions | `ApprovalCard` (the asking tool, every choice, expired and missed) and `QuestionCard` (pages, Skip, Other) | chat-next's own bare cards in the composer's slot | Feed the app's cards from `Waiting`, answering through `respond` |
| A missed question's Ask again | Sends through the chat's own send | `ClarifyCard` calls `chat.ts`'s `sendMessage`, the old engine, which writes rows chat-next never draws | Give the card the controls' `send` |

## Needed before chat-next is the default

| Area | Current screen | chat-next |
| --- | --- | --- |
| Model and compaction dividers | `ModelChange` where the model changed; `Compacted` with how full the context was | Neither: a seam draws inside its reply with no size, since the view passes no `compactions` |
| Interfaces (OpenUI) | `useDraws` hands each row its `blocks` | No `blocks`, so an interface draws as its code fence |
| Stats | Tokens a second and the turn's figures (`showStats`) | `showStats={false}`, and nothing measures them |
| The limit banner | `LimitBanner` above the composer | None |
| The header's line | What the session is doing, its bot and repos (`sessionSubtitle`), or the reply count beside Main | Title and picture only; a session is not centred |
| Long chats | Opens on its newest `FIRST_ROWS` and draws the rest a beat later | Draws every turn at once, and compares every turn by `JSON.stringify` on each change (`shared` in `page.tsx`) |
| Following the reader | `FollowOnSend` and `FollowAfterApproval` | The scroller's own `autoScroll` only |
| Interim words | `message.interim` adds the reply's interim text where it wasn't already streamed (`hermes.ts`) | Not read, so those words appear only once the transcript has them |
| Break reminders | `useBreakReminderEligibility` while a run works safely in the background | Not called |
| Dictation's hint | The chat's title, project and repos | Not passed |
| This device's own photos | Drawn from the bytes this device holds, so they show with the host away | Drawn from the host's path only |
| A bot without the plugin's queue | A message sent mid-reply waits on the device | Refused with a toast; the plugin is mandatory, so this may stand |

## Not gaps

- A bot's Main: triage before every send, its thread cards, day headings and moved markers, its header, empty state and `/thread`, and a thread's way back to it.
- The send path, the plugin queue, steering, a project session's workspace, the pills above the composer, the follow-up reads, the host's title, read marks and the code font match the current screen (ADR 0065, PR #669).
- Keyless bots and Hermes older than 0.22.5 stay on the current screen by design (`route.ts`, `MIN_HERMES`).
