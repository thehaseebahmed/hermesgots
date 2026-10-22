# Chat

Chat is the app's front door: a thread with a composer at the bottom. A message is sent to the bot's
Hermes host, the reply streams into the thread and into the device's IndexedDB, and the chat keeps
its place in the sidebar's Recents across reloads.

## Sub-features

- `chat-send` — a new chat sends its message and the reply streams to `done` with text (`chat-message`).
- `chat-recents` — the chat appears under the sidebar's Recents once it has a turn (`chat-message`).
- `chat-drafts` — a composer draft is kept per chat and cleared on send (`drafts`).
- `chat-failed-send` — a message the host never received stays in the thread marked Failed, to send
  again or drop (`failed-send`).
- `chat-reattach` — a reply still streaming when the page reloads picks its run up and finishes
  (`reattach`).
- `chat-submission` — two sends made at once start one run and get one reply (`submission`).

## How to get to it (user POV)

- The app opens on a chat: the thread with the composer under it.
- A chat from the sidebar's `Recents` navigation.
- The chat's own URL, `/c/<id>`.
- The bot's thread list at `/b/<botId>` for a bot's chats.

## Driving it with the e2e flows

Preconditions:

- Baseline state (features/README.md): app and `live` mock up, `doctor.sh` exit 0.
- No other run is driving this instance. `$GOTS_VERIFY_ARTIFACTS` names where proof goes.

- **Send and receive.** Start a new chat, type into the composer and press Enter. Run
  `pnpm e2e chat-message --shots "$GOTS_VERIFY_ARTIFACTS/<run-id>"` (from `app/`). The drive's steps
  are `await send("hello there")` — it fills `page.getByRole("textbox").last()` and presses Enter —
  then `page.waitForURL("**/c/**")`, the opener text `hello there` visible, and
  `until(() => lastReply(chatId), …)` reading the stored reply row with `status: "done"` and
  `length > 0`. The proof is `PASS: a new chat sent its message and got a N-character reply` and the
  `chat-message-reply.png` screenshot.
- **Recents.** The same flow: `getByRole("navigation", { name: "Recents" })` holds a link to the new
  chat after the reply lands. The chat's title is what the flow seeded (`titleEdited: true`), not
  the host's auto-title.
- **Drafts.** Type without sending, open another chat, come back. Run `pnpm e2e drafts`. The typed
  text is still in the composer per chat, and gone from the chat it was sent in.
- **Failed send.** A message the host never acknowledges is marked Failed in the thread and offers
  send-again and drop. Run `pnpm e2e failed-send`. The row's status is the stored side effect; the
  visible Failed marker alone is not the proof.
- **Reload mid-reply.** Reload the page while the reply streams. Run `pnpm e2e reattach`. The reply
  continues to `done` after the reload — read back with `lastReply`, not just seen in the bubble.
- **Concurrent sends.** Send twice quickly. Run `pnpm e2e submission`. One run and one reply arrive
  (the second send queues while the first streams).
- **Proof of a whole pass.** Keep the run's `PASS:` transcript and the `chat-message-*.png` shots in
  `$GOTS_VERIFY_ARTIFACTS/<run-id>`; they name the feature id and the entry point (the composer).

## Gotchas

- A send from the composer while a reply is still streaming *queues* the message instead of sending
  it. A journey that needs a send to fail or to start its own run must wait for the chat to be idle
  first: poll Dexie until no message is `streaming` and none is `queued`.
- The composer is `getByRole("textbox").last()`; screens with a search field have other textboxes.
- Hermes's auto-title renames a chat after its first turn unless it was seeded `titleEdited: true`
  (which `seed` does). Assert the seeded title, not a renamed one.
- The mock keeps state between flows: seeded chats carry a session id new to the mock
  (`runId()` inside `seed`), so two runs never share a transcript.
- A reply seen in the bubble is not proof of persistence: `lastReply(chatId)` must read the row from
  IndexedDB, and the chat must still open from Recents after a reload.
