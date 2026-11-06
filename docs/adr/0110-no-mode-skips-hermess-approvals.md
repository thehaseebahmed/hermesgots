# No mode skips Hermes's approvals

A project session's Auto mode turned on Hermes's per-run approval bypass
(`tools.approval.enable_session_yolo`) from the plugin's `pre_tool_call` hook, and switching a session
to Auto answered, once, every approval its runs were already waiting on
(`resolve_gateway_approval`). AFK sessions ran in Auto, so an unattended task never stopped at a risky
command ([ADR 0011](./0011-afk-dispatches-a-projects-tasks-and-answers-no-gate.md)).

The Hermes plugin catalog's rule 12 says a listed plugin never routes around Hermes's approval system:
no auto-approving and no disabling guards. Both were exactly that, and `enable_session_yolo` is not part
of Hermes's published plugin API either. So the plugin no longer touches approvals at all:

- **Auto is gone.** The modes are Accept edits (Hermes's own behaviour: a dangerous command waits for the
  user) and Plan. A session stored in Auto, or an older app asking for it, reads as Accept edits on the
  host (`sessions.LEGACY_MODES`) and in the app (`sessionMode`). The Mode list and the plan card offer no
  Auto, so the app never promises a bypass.
- **AFK sessions run in Accept edits.** A task whose agent reaches a dangerous command waits for the
  user; that is a session the host reports as waiting, with the approval push the user already gets.

This supersedes ADR 0011's choice of Auto for AFK, which rejected Accept edits because "a session that
stops at its first risky command is the stall the switch exists to remove". That cost is real and is
now accepted: an AFK task that needs an approval stalls until the user answers it. The alternative —
keeping a bypass — would keep the plugin out of the catalog.

## Considered options

- **Keep Auto as a label for Accept edits.** Rejected: two names for one behaviour, one of which reads
  as a promise the host no longer keeps.
- **Ask Hermes for a reviewed seam** (an approval policy a plugin may declare, enforced by core). Left
  open: that is Hermes's decision to make, and the plugin works without it.

## Consequences

- An approval is answered only by a person, through Hermes's own route, on any surface.
- Community usage counts no new `auto` days; the board keeps the ones already reported.
