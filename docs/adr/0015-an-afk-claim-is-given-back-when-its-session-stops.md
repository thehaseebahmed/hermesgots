# An AFK claim is given back when its session stops

AFK holds one task per project, and a hold lasts exactly as long as the run working it. When a run
finishes, the project lets go of the task but leaves the claim on GitHub — the work is in review, and
taking the claim off would put the issue back in the frontier for the next sweep to pick up again.
When the user closes the session — discarded, resolved, or deleted — the claim comes off, because the
user has said that work is over. A start that never gets its run away gives the claim back too.

The hold is the host's own row (`project_afk`), so it has to survive things the run doesn't: the
process restarting, the user closing the session from another device, the plugin being reloaded. That
is why the session's id is written on the row before the run is posted, why the reason a run stopped
is recorded there, and why closing a session is read from the chat list — the app's own record of
discard and resolve — rather than from a route, which only a device that was there would call.

A claim nothing is working is the state worth reporting. The session keeps its transcript, its
worktrees and its claim, and the project records why nothing is running it; `runs/live` then carries
that session as `{ kind: "stalled", reason }` beside the questions and approvals it already reports,
so the sidebar's Waiting for input and Code's Waiting on you name it with the host's own words. A
failed run says "The run failed." at once; a session a restart adopted says so once the claim has had
`STALL_SECONDS` to become one, since a start still making its worktrees looks the same as a stall
from outside.

## Considered options

- **Taking the claim off as soon as the run ends.** Rejected: the task is in review, and a sweep
  that takes it again would start a second session on work that already has a pull request.
- **Releasing from the close route only.** Rejected: a session closed on another device, or while the
  host was down, would keep its claim forever. The chat list is last-write-wins and is what the user's
  own discard or resolve writes, so reading it is reading the user's decision, wherever it was made.
- **Restarting an adopted session's run.** Rejected: the transcript is the work; a second run would
  either double the work or throw it away, and neither is the plugin's decision to make. The session
  waits for the user, as an approval does.
- **A new waiting kind only in the app.** Rejected: a phone with the app closed has no idea a claim
  stalled, and the plugin is what holds the claim. The host reports it, and the app renders it.
- **Giving the claim back when AFK is switched off.** Not this decision: turning the switch off stops
  future sweeps; what happens to a claim already held is the switch's own question.

## Consequences

- The row keeps three more columns (`session_id`, `stalled`, `stalled_at`, schema v26), so a restart
  can adopt the session it was working rather than start a second one on the same task.
- Releasing is best-effort on GitHub: a refusal is recorded for the sheet and the hold is dropped
  anyway, since nothing on the host is working the task either way.
- The user's Discard or Resolve on an AFK session is a decision about the task, not only the session:
  the claim comes off and the task returns to the frontier, where the next sweep may take it again.
