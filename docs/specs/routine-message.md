# A routine's message is the bot's message

Status: grilled 2026-11-02 against the code, the glossary and the ADRs it touches; every decision
below is settled and recorded in ADR 0081. Published as #788 with tickets #789, #790, #791, #792 and
#793, which are worked in that order. The spec carries `ready-for-agent` and the tickets stay bare, so
the agent claims the spec and works the graph. #788 is blocked by the gate issue #795, which the docs
pull request #794 closes: work starts on that merge, when this file is on `main`.

## Problem Statement

A **routine** works while the phone is away and has no way to speak in a chat. Hermes delivers a
finished job's output to a platform chat — Telegram, Slack, a webhook — or to a profile's own Bot
Chat, and to nothing else: an `api_server` origin is dropped twice over (the scheduler treats it as
missing, and the adapter's `send()` is a stub), so a job created from Gots can never deliver into the
chat it was asked in. The routine's only trace in the app is a bar on Routines and, when it fails, a
push.

So the one thing a user asks a routine for — *tell me when it is done* — arrives everywhere except
the conversation they are having. What the routine found is not in the thread, the bot has no memory
of saying it, there is nothing to reply to, and the run that produced it cannot be opened: the
Routines screen's run row carries no session id, and a cron-sourced session refuses turns.

## Solution

A routine posts a message into a chat **as the bot**. The message is a real row in that chat's Hermes
session — drawn in the thread, in the model's history, replyable and discussable — written by a new
tool, `chat_notify`, that a cron run calls with its routine's id and its text.

- It lands in the bot's **Main thread** unless the call names another chat.
- It can carry up to five attachments, drawn and downloaded like any reply's.
- When the chat is in a turn, or was active in the last fifteen minutes, the message opens with one
  of fifteen aside openers ("On a side note, ", "As a quick aside, ", …), picked at random, so both
  the bot and the user read it as an aside rather than a reply.
- Each message carries a chip that opens that **routine run** read-only in a sheet — the subagent
  sub-thread's own pattern — because Hermes refuses turns on a cron session while reading it freely.
- The device is told with a new push, **Messages from Bots**, which opens the chat.

## User Stories

1. As someone who asked a bot to watch something overnight, I want its finding to arrive in the chat
   I asked in, so that I do not have to go looking for it on a Routines screen.
2. As a user reading that message, I want to reply to it and have the bot know what I am talking
   about, so that the conversation continues instead of restarting.
3. As a user who was mid-conversation when it arrived, I want the message to read as a side note, so
   that I do not mistake it for an answer to what I just said.
4. As a user who was away, I want the message to arrive plainly, without an aside, so that it reads
   as the thing I asked for.
5. As a user with two devices, I want the message on both, so that the chat reads the same everywhere.
6. As a user reading it on a phone, I want a notification that says a bot has a message, so that I
   know to open the chat.
7. As a user who taps that notification, I want the chat with the message in it, so that I land where
   the message is.
8. As a user who wants to know how the routine reached that conclusion, I want one tap to open the
   run, so that I can read what it did.
9. As a user reading the run, I want it read-only and honestly so, rather than a composer that would
   refuse me, so that I am not left typing into a dead end.
10. As a user whose run has aged off the host, I want to be told that rather than shown a spinner, so
    that I know the record is gone.
11. As a user who asked for a chart, a photo or a document, I want it attached to the message, so that
    I do not have to fetch it from somewhere else.
12. As a user on a slow connection, I want images drawn inline and other files offered as downloads,
    so that the thread behaves like every other message.
13. As a user who turned a bot's notifications off, I want this message silent too, so that a mute
    means a mute.
14. As a user who wants fewer interruptions, I want to switch "Messages from Bots" off on my phone or
    in the app, so that the message still arrives without a notification.
15. As a user reading an older chat, I want the message to still be where it happened after the chat
    compacts, so that the thread does not lose it.
16. As a user who sees the same routine post twice, I want it to have posted once, so that a retried
    run does not double the thread.
17. As an operator of a bot, I want the routine restricted to naming itself, so that a message can
    always be traced to the run that wrote it.
18. As a reader of the code, I want the message to be the bot's own words rather than a card dressed
    as one, so that nothing in a thread is invisible to the model reading it.

## Implementation Decisions

- **The message is an assistant row in the transcript**, written with the display kind
  `routine_message`, after resolving the chat's session to its compression tip. Assistant is the
  honest attribution: the routine's agent composed those words. It is also safe — consecutive
  same-role messages are merged before an Anthropic request, and alternation is repaired — and the
  merge is why the aside opener exists, since the model then reads the message as a continuation of
  its previous reply.
- **The text is redacted before it is written**, through Hermes's own redactor, as cron delivery does
  at its single chokepoint.
- **The aside is a fact about the chat, decided at write time.** It is true when a turn lease was held
  on the chat, or when the chat's recency is under fifteen minutes. Recency is the freshest of the
  session's last-activity stamp and its newest message, floored at its start — not the bare stamp. The
  lease is keyed by the compression-lineage root, so the chat's root is walked first, and a row past
  its expiry is stale rather than held.
- **A busy chat queues.** The tool waits briefly for the lease to clear, then parks the message and
  answers `queued`; a ticker writes it when the chat is free. A row written mid-turn would split a
  streaming reply, so the write never races a live turn.
- **The opener is one of fifteen, chosen when the message is taken** and stored with it, so a queued
  message and any retry keep the same words. The list lives in the plugin, seeded by the module, and a
  stored override in the profile's host settings lets the wording be tuned without a release.
- **Attachments are staged, not referenced.** Each file is copied into the profile's attachments
  folder before its `MEDIA:` tag is written, because Hermes's media path check is a denylist only in
  default mode and becomes an allowlist plus a recency check under strict mode. Caps are the media
  route's own, by kind.
- **v1 is routines only.** The tool requires the routine's id, refuses when it is not called inside a
  cron run, and refuses a job it cannot read. It is named `chat_notify` — subject first, plain verb, no
  prefix — and the routine's id is what names the message's origin and its run.
- **The run mapping is a row in the plugin's store**, keyed by the run's execution id, carrying the
  chat, the routine's id and name, the run's own session id (the cron session the tool was called
  from) and the opener. The app reads it per chat from a new route, which resolves each message's
  current transcript row at read time — a compaction re-emits carried rows under fresh ids, so a
  stored row id would rot while the display metadata survives.
- **The app draws the row as its own bot message.** Both folds need the case: today an assistant row
  following a finished reply is appended to that reply. The chip sits on the message and opens a sheet
  that reads the run's session with the normal transcript reader and no composer — the subagent
  sheet's pattern, which already reads an arbitrary session id.
- **One new push kind and one new category.** The kind is `routine_message`; the category is
  `routine_message` under the Routines feature, titled "Messages from Bots", on by default at
  importance 3 — it sounds, and does not peek, since the app's rule is that only what waits on the
  user may peek. The push still carries no text: title, bot character, kind and session.
- **The registry's allowlist must deploy before any host sends the kind**, or every Android push is
  refused; the five lists that must agree are the plugin's kinds and categories, the registry's, the
  app's union and categories, and the service worker's body sentences.

## Testing Decisions

A good test here proves a behaviour a reader could see: a message draws as the bot's own, an aside is
chosen and kept, a queued message lands once, a run opens and an expired one says so. It does not
assert which private function composed the prefix.

The seam is the tool handler and the route on the plugin side, and the fold on the app side — both
existing seams, no new one. The plugin's handler tests sit beside the modules that own a route; the
app's fold tests sit beside the folds and the agent-card tests.

- The plugin: target resolution, the row's role and display kind, the aside for a live lease and for a
  recent chat and its absence for a quiet one, the root walk on a compressed chat, queue then write,
  idempotency by execution id, redaction, attachment staging and refusal, and the route resolving a
  carried row's new id.
- The app: component tests over seeded rows prove the row is its own message in both folds, that the
  chip opens the run with the transcript drawn and no composer, and that an expired run reads as gone.
- The push lists are already checked by the parity test; the parts it does not cover — the registry's
  body sentences, the untitled fallback, the tap path — are checked by hand in the ticket that adds
  the kind.
- A mock-backed flow proves the end-to-end shape: a row with the display kind plus the route's
  mapping, and a tap that opens the run.

## Out of Scope

- **Any caller but a routine.** A chat turn cannot post into another chat in v1.
- **Editing or retracting a message.** Once written it is the bot's, like any other.
- **Replying inside the run sheet.** Hermes refuses turns on a cron session; the sheet is read-only.
- **Continuing the run from the chat.** No new turn is started by a message.
- **Notification text.** The push says a bot has a message, never what it says.
- **Thread-level routing.** A message lands in the chat it names or in Main; it does not open a new
  thread, and triage plays no part.
- **More than five attachments**, and any attachment the media route would refuse.

## Further Notes

A display-only card was the first design and was rejected: something that looks like part of the
conversation but that the bot cannot see is worse than an honest message the bot really said. The
read-only run sheet survives from it, because the run is the one thing a message cannot be.

## Tickets

- [ ] #789 — feat(chat): a routine posts a message into the chat
- [ ] #790 — feat(chat): a routine's message says it is an aside
- [ ] #791 — feat(chat): a routine's message carries its files
- [ ] #792 — feat(chat): a routine's message opens its run
- [ ] #793 — feat(push): tell a device a bot has a message

## Build order

1. #789 — the row, the tool and both folds. Edge: none.
2. #790 — the aside and the queue. Edge: #789.
3. #791 — attachments. Edge: #789.
4. #792 — the chip and the run sheet. Edge: #789.
5. #793 — the push kind and its category. Edge: #789.

## Risks

- **Writing into a turn.** A row written while a turn is live lands after the request the turn was
  built from and before its reply, splitting the reply in the thread and in the model's view. The
  queue is the fix, and a review should see the write only ever happen behind a cleared lease.
- **The lease read missing a compressed chat.** The lease is keyed by the lineage root; reading it by
  the chat's own id finds nothing on a compressed chat, and the message would then be written mid-turn
  exactly when the chat is busiest.
- **A merged message reading as a reply.** The provider merges consecutive assistant messages, so a
  message with no opener is indistinguishable from the bot carrying on. The opener is the only signal
  the model gets; dropping it for quiet chats must stay tied to a genuinely quiet chat.
- **A stored row id rotting.** Compaction re-emits carried rows under fresh ids. A mapping that stored
  the row id would point at nothing after the first compaction; resolving at read time from the
  execution id is the fix.
- **The registry refusing every Android push.** An unknown kind is a 400 at the registry. The kind has
  to be live there before a host sends it, and an older app reads it as an unknown kind.
- **A stale artifact served as an attachment.** Under strict media mode the route refuses a file
  outside the allowed roots or older than the recency window; staging into the profile's folder before
  writing the tag is what makes the attachment survive the run's own cleanup.
- **The attachments folder growing.** Staged copies are never pruned in v1; a routine that posts a
  file a day accumulates them. Worth recording rather than discovering.
