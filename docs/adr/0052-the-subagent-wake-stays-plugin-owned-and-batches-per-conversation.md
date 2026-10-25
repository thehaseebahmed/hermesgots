# The subagent wake stays plugin-owned and batches per conversation

Hermes's gateway already drains the completion queue in the plugin's own process: for an API-server
session its watcher claims the durable row, writes an `async_delegation_complete` transcript row and
starts no turn (#85957, because a turn started that way could cross a human-confirmation gate). The
wake that reads the result stays the plugin's (ADR 0038), so a second consumer of core's ledger would
only race that watcher — whoever claims first starves the other, and a plugin that won would stop the
transcript row the app draws as the subagent result from being written at all. The plugin therefore
never claims on core's ledger: it keeps its own mark and posts an ordinary `POST /v1/runs` through the
outbox, so a wake stays a run the app can follow and `runs/live` can see.

What changes is that the wake gets the guarantees core's own delivery has, built on the plugin's side.

- **One wake per conversation per sweep.** The ended, unwoken, non-stage children of one root are woken
  in one run under one batch header. There is no extra window: the sweep and the deferral already
  batch. The batch's membership is written as an intent row before the post, and its id is the
  idempotency key (`wakeb_<id>`), so a retry after a lost response reuses the stored members instead of
  posting a different set under a different key; a child that ends meanwhile belongs to the next batch.
  A lone child keeps `wake_<child id>`, so a host upgraded mid-flight cannot fire twice. Results are
  cut to about 20k characters each and about 40k together, saying so.
- **Every wake ends in a disposition.** `subagent_wakes` gains a status, an attempt count and the next
  attempt's time. A held wake (a turn running, the user being asked) costs nothing; a transient failure
  backs off to 8 attempts; a stage child, a gone target and a child that ended over 48 hours ago are
  marked `dropped` with a reason and never read again. A mark with no status reads as sent. Marks, not
  the `subagent_wake_since` watermark, decide what is owed after a restart; the watermark stays only so
  an upgraded host's history is never a backlog.
- **The post is re-checked.** A turn or a gate that appears between the check and the post marks the
  batch held with its key kept, rather than posting twice.
- **The wake text is rebuilt from the child's transcript,** with core's truncation note and recovery
  lines added so it reads like core's notice.
- **Core internals are read defensively.** Everything the plugin takes from core (`_active_subagents`,
  `_run_statuses`, the notice text in `tools/process_registry_notifications.py`) is read with
  `getattr` and degrades to the previous behaviour, and a CI job checks the names and shapes against
  the latest Hermes release and `main` on pull requests that touch the delegation code and weekly.

## Considered options

- **Claiming core's durable delivery** (`claim_event_delivery` and its siblings, replay through
  `restore_undelivered_completions`, text and redaction from the event). Rejected for now: it needs
  the plugin to win the watcher's claim, and a lost claim silently drops the transcript row.
- **Wrapping the gateway's api_server branch** (`_self_post_api_server`) so the claim holder also
  starts the turn: the real equivalent of core's push path, but a monkeypatch of a private gateway
  method. Deferred.
- **`run_internal_session_turn`** (core's in-process wake): creates no run id and no events stream, so
  the app could not follow the wake turn live.
- **`admit_route_wake`** (the session FIFO): reached only for push-capable adapters, which need a
  `SessionSource` and a gateway runner an API-server session does not have.
- **Reading the result from core's ledger** (`async_delegations.result_json`, already redacted when it
  is stored): it is keyed by delegation id, and a child session cannot be matched to a row without
  guessing from the parent and the goal text. Revisit if core exposes a delegation-to-child key.
- **An upstream opt-in** for waking API-server sessions without crossing a gate: not raised now.

## Consequences

- This adds to ADR 0038's wake and changes none of its rules: a wake still waits while a question or
  approval is pending, and a stage still keeps its one run.
- Core does not batch API-server completions (each is its own delivery row), so a batched wake sits
  beside one delivery row per child; whether the model sees a result twice, once as the delivery row
  and once in the wake, is checked against a real Hermes before building on it.
- Whether a run posted over a live turn of the same session queues or runs beside it is not settled
  from core's source; the re-check after the post is built to hold either way, and is confirmed live.
- Dropping core's ledger, claim, FIFO and completion event keeps the plugin free of new private
  dependencies, at the cost of polling `state.db` every 5 seconds.
