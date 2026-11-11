# A routine's message is the bot's message

**Superseded on one point by [ADR 0137](0137-a-routines-delivery-is-a-chat.md)** (2026-11-10): a delivery publishes a chat record for the run rather than writing a message into a chat. The rest of this — the platform, the ledger, the wrapper, the suppression — stands.

A **routine** works with the phone away and has no way to speak in a chat. Hermes delivers a finished
job to a platform chat — Telegram, Slack, a webhook — or into a profile's own Bot Chat, and to nothing
else. A job created from a Gots chat captures an `api_server` origin, and that origin is dropped
twice: `_origin_from_env` refuses to stamp a surface that cannot be pushed to, and `_resolve_origin`
treats the platform as missing at fire time. The job lands on `deliver: local`, and the routine leaves
a bar on Routines and, on failure, a push. What it found is not in the thread, the bot has no memory
of saying it, and there is nothing to reply to.

Two designs were rejected before this one. A display-only card drew the routine's text between
messages while the model stayed blind to it — a thing that looks like part of the conversation but is
not is worse than no message at all. A plugin tool that wrote the message itself worked, but
re-implemented what Hermes already ships: a delivery path with a ledger, exactly-once claiming,
retries, `[SILENT]`, `failure_deliver` and the notify flag. The tool was the wrong unit.

Gots is a **platform**. The plugin registers one with `ctx.register_platform`: an outbound-only
adapter whose `send()` writes the message, a `standalone_sender_fn` for a scheduler running without a
gateway, and `cron_deliver_env_var`, which is what makes `gots` a legal name in a job's `deliver`.
`supports_async_delivery` is false, because a surface that cannot wake a turn must not promise one.
No home channel is set: a bare `deliver: gots` then fails loudly and `deliver: all` skips the
platform, so every target is explicit. The target is `gots:main`, the bot's Main thread; the ref
reaches the adapter raw, because declaring a target parser makes cron strict and drops what it cannot
parse.

A routine made in a chat has to name that target, and Hermes has no cron-created hook to fill it in.
Two built-ins do it: a plugin system prompt section — the mechanism this plugin already uses for its
interface library — tells the bot to deliver there, and a `pre_tool_call` directive fills `deliver`
only when the model omitted it. The directive rewrites arguments before the tool records them; a
`post_tool_call` rewrite would be a second write after the model was already told something else, and
its return value is ignored anyway.

The message itself is an assistant row written at the chat's compression tip, with the display kind
`routine_message`. This is the one gap: Hermes has no writer that produces an assistant row carrying a
display kind. `mirror_to_session` is the right entry point — it is real-assistant by default and
callable from a cron process — but it drops `display_kind` and metadata at the SQLite boundary and
fences nothing. The fenced, idempotent writers (`append_completion_note`,
`append_delegation_delivery`) write user rows, which would make the model read the routine's words as
the user's, and that is exactly the confusion this feature exists to avoid. So the adapter calls
`append_message` and owns the fence: it reads the chat's turn lease at its compression-lineage root,
waits briefly, and queues the message when the chat is busy. A three-line change to
`mirror_to_session` that forwarded `display_kind` would let this be deleted.

The wrapper is stripped. "Cronjob Response:", the `(job_id: …)` line, the rule and the stop/manage
footer are Hermes's framing for a human reading a channel; in a thread they read as scaffolding.
`cron.wrap_response` stays at its default for every other target.

The run is identified by Hermes rather than by parsing a session id: `list_cron_job_runs` resolves a
job to its runs, and the live lane hands the adapter the job id in its routing metadata. The
standalone lane carries no identity at all, so the adapter reads the job id out of the wrapper line it
is already removing, and a message it cannot attribute simply has no chip.

The aside — one of fifteen openers, chosen at random and stored with the message — exists because the
provider merges consecutive assistant messages. The model reads the delivery as a continuation of its
previous reply, so the words have to say what they are. It is decided at delivery time: a turn lease
was held on the chat, or the chat's recency is under fifteen minutes.

The push is made from inside the delivery, which is what inherits `[SILENT]`, `deliver: local`,
`failure_deliver: local` and `cron.delivery.notify`. A ledger poller — the shape `routine_failed`
already uses — would have to re-apply all four, and `alerts.check_routines` does not.

## Considered options

- **A display-only card in the thread.** Rejected: it puts host content where only the bot's own words
  belong, and the bot is blind to what the user is reading.
- **A plugin tool the run calls.** Rejected once the delivery path was read: it rebuilt the ledger,
  the retries, the suppression and the notify flag, and gave the model a second way to speak that
  Hermes did not have.
- **`deliver=origin` from a Gots chat.** Rejected by Hermes, not by taste: an api_server origin is
  refused at capture and at fire, and the adapter's `send()` is a stub.
- **`deliver=bot-chat`.** Rejected: it targets the profile's canonical Bot Chat (the TUI/Desktop
  transcript), not a Gots chat, and costs the bot an agent turn.
- **A user-role row, as cron's own mirror writes.** Rejected: the model would read the routine's
  finding as something the user said.
- **A second bot identity for automation.** Rejected: platforms that get this right post as the one
  bot the user already talks to; a second identity in a thread is a different author.

## Consequences

- Enabling the platform is a setup step: `platforms.gots.enabled` and a gateway restart. Without it,
  delivery fails with Hermes's own error — the tool had no such cost.
- The message is in the model's context merged into the previous assistant message; the aside opener
  is the only signal that it is not a continuation.
- The run sheet is a dead end by Hermes's rule. Discussion happens in the chat.
- A run pruned from the host can no longer be opened; the sheet says so.
- A message cannot be edited or retracted once written — it is the bot's.
- The push vocabulary grows to seventeen categories, and the registry's allowlist has to carry the
  kind before any host sends it.
- Gots jobs must carry `attach_to_session: false`, or Hermes mirrors the same delivery a second time
  as a user row.
