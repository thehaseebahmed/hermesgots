# A routine's message is the bot's message

A **routine** works with the phone away and has no way to speak in a chat. Hermes delivers a finished
job to a platform chat — Telegram, Slack, a webhook — or into a profile's own Bot Chat, and to nothing
else. A job created from Gots carries an `api_server` origin, and that origin is dropped twice over:
the scheduler treats it as missing (`_NON_PUSH_ORIGIN_PLATFORMS`), and the adapter's `send()` is a
stub. So the one thing a user asks a routine for — *tell me when it is done* — arrives everywhere
except the conversation they are having. The routine leaves a bar on Routines and, on failure, a push;
what it found is not in the thread, the bot has no memory of saying it, and there is nothing to reply
to.

The first design kept it that way and drew a card instead: the routine's text stored on the host,
rendered between messages, tapping through to the run. It was rejected for the reason a thread is a
thread — a thing that looks like part of the conversation but that the model cannot see makes the bot
a liar about its own history. Either the bot said it or it did not.

It said it. `chat_notify` writes the routine's text into the chat's Hermes session as an **assistant
row**, with the display kind `routine_message`, after resolving the session to its compression tip.
The row is ordinary history: drawn in the thread, in the model's next prompt, replyable, and carried
by compaction like any other message. The routine's agent composed those words, so writing them as
the bot's is attribution rather than fiction.

Writing an assistant row between turns is safe in this codebase. Consecutive same-role messages are
merged before an Anthropic request (`_merge_consecutive_roles`), and alternation is repaired where it
is not merged. The merge has a consequence the design leans on: the model reads the message as a
continuation of its previous reply, not as a turn of its own. That is why the message can open with
one of fifteen aside openers — "On a side note, ", "As a quick aside, " — chosen at random, so the
bot and the user both read it as an aside. The opener is chosen when the message is taken and stored
with it, so a queued message and a retry keep the same words.

The aside is a fact about the chat, decided durably. It is true when a turn lease was held on the
chat, or when the chat's recency is under fifteen minutes — the freshest of the session's
last-activity stamp and its newest message, floored at its start. The lease is keyed by the
compression-lineage root rather than the session id, so the chat's root is walked first, and a row
past its expiry is stale rather than held. A chat in a turn is never written into mid-turn: the tool
waits briefly, then queues the message and answers that it queued, and the row is written when the
chat is free, because a row written mid-turn splits a streaming reply.

Attachments are `MEDIA:` tags on that same row, which is how a reply already carries files. They are
staged into the profile's attachments folder first, because Hermes's media path check is a denylist
only in default mode and becomes an allowlist plus a recency check when strict — a stale artifact in
a temp directory would be refused by the very route that serves it.

The run is one tap away and read-only. The plugin records the execution, the chat, the routine, the
run's own session id and the opener, and the app asks for that mapping per chat; the route resolves
each message's current row at read time, because a compaction re-emits carried rows under fresh ids
while the display metadata survives. The sheet it opens reuses the subagent sub-thread's reader on
the run's session, with no composer. That is the ceiling rather than a choice: a `cron`-sourced
session refuses turns and allows reads.

The device is told with one new push, `routine_message`, in a new category under Routines titled
**Messages from Bots** — on by default, importance 3, so it sounds and does not peek, and tapping it
opens the chat. The push still carries no text.

## Considered options

- **A display-only card in the thread.** The first design, rejected above: it puts host content where
  only the bot's own words belong, and the bot is blind to what the user is reading.
- **A posted run on the chat's session, so the bot writes it.** Rejected: it costs a model call per
  notification, delays the message behind a generation, and lets the bot rewrite or drop what the
  routine actually found. The routine's own agent already composed the words.
- **Hermes's own delivery (`deliver=bot-chat`, `attach_to_session`).** Rejected: `bot-chat` targets
  Hermes's canonical Bot Chat session, not a Gots chat, and the mirror path only reaches gateway
  platform chats — `api_server` is excluded from both by design, and nothing in a job's schema names
  a session.
- **A user-role row, as cron's mirror and detached results use.** Rejected: the model would read the
  routine's finding as something the user said, and the whole point is that the bot said it.
- **A second bot identity for automation.** Rejected: platforms that get this right (Slack's bot
  token, Telegram's bot token, Discord's bot route rather than a webhook) post as the one bot the user
  already talks to. A second identity in a thread is a different author.

## Consequences

- The message is in the model's context merged into the previous assistant message. The aside opener
  is what keeps it readable there; a message with no opener reads as a continuation.
- The run sheet is a dead end by Hermes's rule. Discussion happens in the chat.
- A run pruned from the host can no longer be opened; the sheet says so.
- A message cannot be edited or retracted once written — it is the bot's.
- The push vocabulary grows to seventeen categories, and a device that has not updated reads it as an
  unknown kind. The registry's allowlist therefore has to carry the kind before any host sends it.
