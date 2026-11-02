# A routine's message is the bot's message

Status: grilled 2026-11-02 against the code, the glossary and the ADRs it touches, and re-settled the
same day around Hermes's own delivery mechanism instead of a bespoke tool; every decision below is
recorded in ADR 0081. Published as #788 with tickets #789, #790, #791, #792 and #793, which are worked
in that order. The spec carries `ready-for-agent` and the tickets stay bare, so the agent claims the
spec and works the graph. #788 is blocked by the gate issue #795, which the docs pull request #794
closes: work starts on that merge, when this file is on `main`.

## Problem Statement

A **routine** works while the phone is away and has no way to speak in a chat. Hermes delivers a
finished job's output to a platform chat — Telegram, Slack, a webhook — or to a profile's own Bot
Chat, and to nothing else. A job created from a Gots chat captures an `api_server` origin, and that
origin is dropped twice: the tool never stamps it (a request/response surface has no push), and the
scheduler treats it as missing at fire time. The job therefore lands on `deliver: local`, and the
routine's only trace in the app is a bar on Routines and, when it fails, a push.

So the one thing a user asks a routine for — *tell me when it is done* — arrives everywhere except
the conversation they are having. What the routine found is not in the thread, the bot has no memory
of saying it, there is nothing to reply to, and the run that produced it cannot be opened: the
Routines screen's run row carries no session id, and a cron-sourced session refuses turns.

## Solution

Gots becomes a **delivery platform**, the way ntfy and webhook already are. A routine's answer is
delivered into a chat and written there as the bot's own message:

- The job's `deliver` names `gots:main` — the bot's Main thread — and Hermes's own delivery path
  carries the text, retries it, and honours `[SILENT]`, `deliver: local` and `cron.delivery.notify`.
- The message lands as a real row in that chat's Hermes session: drawn in the thread, in the model's
  history, replyable and discussable.
- When the chat is in a turn, or was active in the last fifteen minutes, the message opens with one
  of fifteen aside openers ("On a side note, ", "As a quick aside, ", …), picked at random, so both
  the bot and the user read it as an aside rather than a reply.
- It can carry up to five attachments, drawn and downloaded like any reply's.
- Each message carries a chip that opens the **routine run** read-only in a sheet — the subagent
  sub-thread's own pattern — because Hermes refuses turns on a cron session and allows reading it.
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
16. As a user whose rule was "only tell me when it matters", I want the routine's own `[SILENT]`
    answer to deliver nothing at all, so that a quiet run stays quiet.
17. As an operator of a bot, I want a message in a chat to name the run that wrote it, so that every
    delivery has its receipt.
18. As a reader of the code, I want the message to be the bot's own words rather than a card dressed
    as one, so that nothing in a thread is invisible to the model reading it.

## Implementation Decisions

- **Gots is a platform, not a tool.** The plugin calls `ctx.register_platform` with an outbound-only
  adapter (`BasePlatformAdapter`; `connect()` marks connected and returns True, `send()` writes the
  message), a `standalone_sender_fn` for a scheduler with no gateway, `cron_deliver_env_var`, and
  `supports_async_delivery = False` — a surface that cannot wake a turn must not promise one.
  `plugin.yaml` carries `kind: platform`. No declarative block replaces the call.
- **No home channel, deliberately.** With `cron_deliver_env_var` declared and the home channel unset,
  a bare `deliver: gots` fails loudly and `deliver: all` skips the platform, so every target is
  explicit and no routine is ever swept into a chat by a broadcast.
- **The target is `gots:<chat>`, and `main` is the chat.** The adapter resolves the ref against this
  profile's chat list (`main` being the bot's Main thread). The ref reaches the adapter raw: no
  `parse_target_ref_fn` is declared, because declaring one makes cron strict and drops refs it cannot
  parse; only `target_ref_syntax_fn` is given, as a hint.
- **The model is told where to deliver, and the default is filled when it is not.** A plugin system
  prompt section — the mechanism this plugin already uses for its interface library — tells the bot
  to pass `deliver: gots:main` when it creates a routine. A `pre_tool_call` directive fills `deliver`
  only when the model omitted it, so an explicit choice always wins; the hook rewrites arguments
  before the tool records them, never the job afterwards. Hermes has no cron-created hook, and
  `post_tool_call` returns are ignored.
- **Enabling the platform is setup, not code.** `platforms.gots.enabled` has to be true in the
  profile's config, and the gateway has to restart for the adapter to connect. The plugin's link step
  writes that config and says the restart is needed; without it, delivery fails with Hermes's own
  "not configured/enabled" error.
- **The message is an assistant row at the chat's compression tip**, written with the display kind
  `routine_message`, redacted by Hermes before it reaches the adapter. This is the one place Hermes
  has no writer to borrow: `mirror_to_session` is the right entry point but drops the display kind,
  and the fenced, idempotent writers (`append_completion_note`, `append_delegation_delivery`) write
  user rows, which would make the model read the routine's words as the user's. So the adapter calls
  `append_message` itself and owns the fence: it reads the chat's turn lease at its
  compression-lineage root, waits briefly, and queues the message when the chat is busy, writing when
  the lease clears. A three-line change to `mirror_to_session` forwarding `display_kind` would let
  this be deleted later.
- **The cron wrapper is stripped in the adapter.** "Cronjob Response:", the `(job_id: …)` line, the
  rule and the stop/manage footer are Hermes's framing for a human reading a channel, not a message
  in a thread. `cron.wrap_response` stays at its default for every other target.
- **The run is identified by Hermes, not by parsing a session id.** `list_cron_job_runs` resolves a
  job to its run sessions, and the live lane also hands the adapter `metadata["job_id"]`. The
  standalone lane has no metadata at all, so the adapter falls back to the job id in the wrapper line
  it is already removing, and a message it cannot attribute simply has no chip. The run's own session
  is what the sheet reads.
- **The aside is a fact about the chat, decided at delivery time.** True when a turn lease was held on
  the chat, or when the chat's recency is under fifteen minutes — the freshest of the session's
  last-activity stamp and its newest message, floored at its start. The opener is one of fifteen,
  chosen when the message is taken and stored with it, so a queued message and any retry keep the
  same words.
- **Attachments arrive as media and are staged.** Hermes extracts them from the routine's `MEDIA:`
  tags and hands the adapter `(path, is_voice)` tuples after its own path policy. Each is copied into
  the profile's attachments folder before its tag is rewritten, because the media route is a denylist
  in default mode and an allowlist plus recency under strict mode. Caps are the media route's own.
- **The notification is pushed from inside the delivery.** That is what inherits `[SILENT]`,
  `deliver: local`, `failure_deliver: local` and `cron.delivery.notify` — a ledger poller would have
  to re-apply all four, and `alerts.check_routines` does not. The adapter honours `metadata["notify"]`
  as the built-in silent flag. The kind is `routine_message`, in a new category under Routines titled
  "Messages from Bots", on by default at importance 3: it sounds, and does not peek, since only what
  waits on the user may peek. The push still carries no text.
- **The registry's allowlist must deploy before any host sends the kind**, or every Android push is
  refused; the five lists that must agree are the plugin's kinds and categories, the registry's, the
  app's union and categories, and the service worker's body sentences.
- **The app draws the row as its own bot message.** Both folds need the case: today an assistant row
  following a finished reply is appended to that reply. The chip sits on the message and opens a sheet
  that reads the run's session with the normal transcript reader and no composer — the subagent
  sheet's pattern, which already reads an arbitrary session id.

## Testing Decisions

A good test proves a behaviour a reader could see: a routine's answer draws as the bot's own message,
an aside is chosen and kept, a queued message lands once, a run opens and an expired one says so. It
does not assert which private function composed the prefix.

The seams are Hermes's own: the adapter's `send()` and the plugin's `standalone_sender_fn` on the
plugin side, and the fold on the app side. Both already exist; no new seam is introduced.

- The platform: registration (name, delivery env var, no home channel), ref resolution (`main` and a
  chat id), the wrapper stripped, the row's role and display kind, the run mapping, the aside for a
  live lease and for a recent chat and its absence for a quiet one, the queue, media staging, and the
  push honouring `notify: false`.
- The delivery path is exercised as Hermes calls it — the adapter directly with metadata, and the
  standalone sender with none — since neither can be conjured by the mock.
- The app: component tests over seeded rows prove the row is its own message in both folds, that the
  chip opens the run with the transcript drawn and no composer, and that an expired run reads as gone.
- The push lists are already checked by the parity test; the parts it does not cover — the registry's
  body sentences, the untitled fallback, the tap path — are checked by hand in the ticket that adds
  the kind.

## Out of Scope

- **Any target but a chat of this profile.** A routine cannot deliver into another bot's chat.
- **Editing or retracting a message.** Once written it is the bot's, like any other.
- **Replying inside the run sheet.** Hermes refuses turns on a cron session; the sheet is read-only.
- **Continuing the run from the chat.** No new turn is started by a delivery.
- **Notification text.** The push says a bot has a message, never what it says.
- **Thread-level routing.** A message lands in the chat it names; it does not open a new thread, and
  triage plays no part.
- **Per-chat targeting from the bot.** `main` is the target in v1; naming another chat is a later
  change, not a hidden feature.
- **More than five attachments**, and any attachment the media route would refuse.

## Further Notes

A display-only card was the first design and was rejected: something that looks like part of the
conversation but that the bot cannot see is worse than an honest message the bot really said. A plugin
tool was the second and was rejected once the platform route was read: Hermes already had the delivery
path, the ledger and the suppression rules, and a tool re-implemented them.

The in-tree copy of this spec is `docs/specs/routine-message.md`; the design decision behind it is
ADR 0081.

## Tickets

- [ ] #789 — feat(cron): a routine's answer lands in the chat as a message
- [ ] #790 — feat(cron): a routine's message says it is an aside
- [ ] #791 — feat(cron): a routine's message carries its files
- [ ] #792 — feat(cron): a routine's message opens its run
- [ ] #793 — feat(push): tell a device a bot has a message

## Build order

1. #789 — the platform, the target and the row. Edge: none.
2. #790 — the aside and the queue. Edge: #789.
3. #791 — attachments. Edge: #789.
4. #792 — the chip and the run sheet. Edge: #789.
5. #793 — the push kind and its category. Edge: #789.

## Risks

- **The platform not enabled.** Delivery to `gots` fails with Hermes's own error until
  `platforms.gots.enabled` is true and the gateway restarted; a user who installs the plugin and
  creates a routine gets a red delivery and no message. The link step writing the config, and the
  error naming what to enable, are the fix.
- **A job that never names the platform.** Omitting `deliver` on an api_server chat stores `local`,
  silently. The prompt section and the `pre_tool_call` default are what stop that; a review should see
  that the fill happens only when the model named nothing.
- **Writing into a live turn.** A row written while a turn is live splits a streaming reply. The fence
  is read from the chat's turn lease at its lineage root and the message queues; reading the lease by
  the chat's own id would miss a compressed chat exactly when it is busiest.
- **A message with no run.** The standalone lane carries no job identity, so a wrapper turned off by
  config leaves nothing to attribute. The message still lands; the chip is simply absent, and that is
  a stated behaviour rather than a failure.
- **A merged message reading as a reply.** The provider merges consecutive assistant messages, so a
  message with no opener is indistinguishable from the bot carrying on. The opener is the only signal
  the model gets; dropping it for quiet chats must stay tied to a genuinely quiet chat.
- **A double write.** A job with `attach_to_session: true` (or a global `cron.mirror_delivery`) makes
  Hermes mirror the same delivery into the chat as a user row, on top of the adapter's own write. Gots
  jobs must carry `attach_to_session: false`, and the ticket that sets the target sets it.
- **Two runs, one job.** Overlapping fires are allowed, so "the newest run for this job" is a race
  when the adapter has no job id. The live lane's `metadata["job_id"]` plus the ledger order is what
  narrows it; a message attributed to the wrong run of the same routine is the visible failure.
- **The registry refusing every Android push.** An unknown kind is a 400 there. The kind has to be
  live before a host sends it, and an older app reads it as an unknown kind.
- **A stale artifact served as an attachment.** Under strict media mode the route refuses a file
  outside the allowed roots or older than the recency window; staging into the profile's folder before
  writing the tag is what makes the attachment survive the run's own cleanup.
- **The attachments folder growing.** Staged copies are never pruned in v1; a routine that posts a
  file a day accumulates them.
