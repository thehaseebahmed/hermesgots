# A question never waits behind a subagent

A bot's turn that delegates no longer waits for its subagents: `delegate_task` returns a handle, the
turn carries on, and every question or approval it raises reaches the user while the subagents still
work. For a long time the plugin forced every delegation synchronous (commit e17f28e, 2026-10-08)
because a background result on an API-server session was only written to the transcript — the agent
never woke on it, so a planner's result sat unread until the user wrote again. That wake is kept
without waiting on Hermes: when a subagent finishes, the plugin posts a wake run on the parent
session itself, through the loopback outbox it already posts AFK runs with, deferred while a question
or approval is pending. Everything ships plugin- and app-side; no Hermes-core change is waited on.

## Considered options

- **An upstream core change** — one capability flag on api_server sessions routing subagent
  completions to core's existing wake path, so core owns the dedupe, interrupt propagation and
  gate-safety the plugin now re-owns. Deferred, not rejected: revisit when Gots may rely on the
  host's Hermes carrying it.
- **Staying synchronous** — the reason this exists: it made every question wait behind every
  subagent.

## Consequences

- A workflow stage does not advance until its run and every subagent that run started have ended;
  completions never wake a stage session, so a stage keeps its one run.
- Stopping a turn stops its subagents; once the turn has ended, each subagent is stopped from its
  own card.
- The plugin owns at-least-once delivery for wake runs (an idempotency key per subagent, and a mark
  on the subagent's session once one is posted) and must never post one while a question or approval
  is pending.
