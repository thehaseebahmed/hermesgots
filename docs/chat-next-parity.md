# chat-next parity

What the current chat screen (`CurrentChatPage` in `app/src/routes/chat.tsx`, over `lib/chat.ts` and `lib/history.ts`) does that a chat drawn by chat-next (`NextChat`, `src/chat-next/`) does not. Audited 2026-10-29 against `ccr-b0990318-q2tg06` by reading both screens, and closed by the work in `docs/chat-next-plan.md` on `ccr-eb6ef31a-3paja1`. Retiring the current screen stays a separate decision (ADR 0065): it is made when nothing the old screen does is missing, and what is left to check before it is below.

## Closed

| Area | How chat-next does it now |
| --- | --- |
| Transcript reads | A chat opens on its newest page (`readNewest`), which is drawn at once, and the older pages are read after it, one at a time, and put above it until one comes back short (`readOlder`, rules in `pages.ts`); the thread keeps the reader's place because every row keeps its id as turns are added above (`origin`), and the loader is over the pane, only while a page is being read. A reply whose request is in a page not read yet is drawn alone (`Turn.cut`) and is whole when the page lands. A page that fails leaves the thread as drawn and is read again from a button, never by itself; the rows held and whether the chat is whole (`SessionState.partial`) are kept on the device, so a chat left unfinished is picked up where it stopped. A device that holds the thread reads only the newest page when it has not moved: the read stops at the first page that joins the held rows (`newestRead`), and a compaction or an undo, which change the newest rows, fail the join and read on; a turn's end reads the whole transcript |
| The change stream | `onSessionMoved` (`lib/live.ts`) catches the open thread up when the plugin says its session moved; the timer drops to `SAFETY_MS` while the stream is open |
| Thinking | The fold keeps a row's `reasoning` with the word or call it led to, a live `reasoning.available` block waits on the turn until the next one takes it, and the message rows carry reasoning runs |
| A thread opening | While the first read is out the thread says it is catching up (`catchingUp` on `ThreadViewProps`, a status line of one rotating word), and a Main still loading draws no greeting. A run the host starts while the thread is open — a wake turn after its subagents — is joined by its id (`useLiveRunId`), also from the session-moved catch-up and when a follow ends |
| The model pill | The composer carries the chat's `ModelMenu`, and so does the plan-ready card |
| The header's options | `ChatActions` and `useChatUsage` (`components/chat/chat-actions.tsx`): the context ring and usage sheet, rename, mute, resolve or reopen, discard and delete, drawn by both screens |
| Stop | One press ends the run and every subagent the session holds, and the composer stays on Stop while one works |
| Approvals and questions | `AppPrompt` draws the app's `ApprovalCard` and `QuestionCard`, answered where chat-next answers |
| A missed question's Ask again | `AskAgainContext` hands the card the thread's own send |
| Model and compaction dividers | Drawn from the chat record the plugin fills (`modelChanges`, `compactions`) |
| Interfaces (OpenUI) | `useDraws` hands each row its `blocks` |
| Stats | A turn this device watched from its start keeps its tokens, speed and time with the row that opened it (`stats.ts`); a turn followed from its middle has none |
| The limit banner | `LimitNotice` above the composer, opening the usage sheet |
| Long chats | `useFirstRows` opens on the newest rows and draws the rest a beat later; turns are compared without building a string each (`equal.ts`) |
| Following the reader | `FollowOnSend` and `FollowAfterApproval` |
| Interim words | `message.interim` joins the reply where the deltas did not carry it |
| Break reminders | A streaming reply counts as background-safe work until it waits on the user or its session closes |
| Dictation's hint | `dictationHint` (title, project, repos) |
| This device's own photos | `sentFiles` (Dexie 29) keeps the bytes of what was sent by the path the host saved it at, so they draw with the host away |

## Decided

- A bot without the plugin's queue refuses a message sent mid-reply with a toast. The plugin is mandatory, so this stands.

## Still to check before the default changes

- **No sweep flow drives chat-next.** `pnpm e2e idle-requests` and the others run the current screen, so the request budget of an idle chat-next thread is argued from `scripts/test-chat-next-reads.mjs` (one page for a thread that has not moved) and not measured in a browser. Following the reader and opening a long chat on its newest rows are geometry: their component tests assert that the scroller is told to move and that the first frame is short, and a browser run is what would show them landing. The one flow that drives chat-next is `chat-next-older`, which measures the reader's place as older pages land above it; it does not count requests.
- **Stats exist only for a turn this device streamed from its start**: the host's transcript carries no usage, so a turn followed from its middle or written on another device has none.

## Not gaps

- The header's activity line and the reply count beside Main. chat-next's header stays constant (Main's thread count, a session's bot and repos); what a reply is doing is drawn in the thread, so the thread has no status to push up to the header.
- A project session's way back to Code (button and Android's back), its empty state with the repos it will work in, and a session left unsent deleted or kept as a draft.
- A bot's Main: triage before every send, its thread cards, day headings and moved markers, its header, empty state and `/thread`, and a thread's way back to it.
- The send path, the plugin queue, steering, a project session's workspace, the pills above the composer, the follow-up reads, the host's title, read marks and the code font match the current screen (ADR 0065, PR #669).
- Keyless bots and Hermes older than 0.22.5 stay on the current screen by design (`route.ts`, `MIN_HERMES`).
