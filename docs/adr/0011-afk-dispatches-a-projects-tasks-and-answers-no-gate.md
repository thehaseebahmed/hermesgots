# AFK dispatches a project's tasks; it answers no gate on the user's behalf

The AFK switch works the ready tasks of a project's GitHub issues while the user is away, and it does
exactly that: it claims a task, starts a session for it, and leaves a draft pull request. It decides
nothing in the user's place. An approval, a plan approval and a clarify question all still wait for the
user — an AFK session runs in Auto, which is Hermes's own per-session approval bypass rather than a Gots
policy, so the hardline blocklist still blocks and a guardian DENY is still left for the user. A session
that meets something only the user can decide therefore stalls and shows in Waiting for input until they
come back; a clarify question is released by Hermes's own timeout, with its default answer.

The alternative — an AFK that answers every gate so no session ever stalls — was designed and left out of
v1. What bounds AFK is the mark on the task: only an issue the user has labelled `ready-for-agent` is ever
picked up, which makes the user's own triage the permission to work. An AFK that also answered gates would
widen that permission from "these specified tasks" to "whatever a session meets along the way", and the
one thing AFK must not do is spend the user's authority on a decision they never saw.

## Considered options

- **Answering approvals, plan approvals and clarify questions.** Deferred, not rejected: it is the
  obvious completion of the feature, and it is a widening of the switch's authority that deserves its own
  decision rather than riding along with the first one.
- **Accept edits for AFK sessions**, leaving Hermes's prompting alone. Rejected: a session that stops at
  its first risky command is the stall the switch exists to remove, and the user would come back to a
  queue of untouched tasks.
- **Plan mode for AFK sessions.** Rejected: it stops after one read-only turn for a plan approval, so an
  AFK task would never produce anything.
- **A mode picker beside the switch.** Rejected: the only mode that makes an unattended session work is
  Auto, and offering a choice whose wrong answers are useless is a trap rather than a control.

## Consequences

- An AFK session is created in Auto, so there is never a waiting approval for Gots to answer; the Auto
  mode's own `answer_waiting` path (switching an existing session to Auto) is not part of AFK.
- A task whose session stalls on a question still holds its claim, and its PR is simply never opened —
  the user finds it in Waiting for input and takes it from there.
- The brief a session is given tells it not to ask: with no gate answered for it, a question is the one
  thing that can hold an unattended run for an hour.
