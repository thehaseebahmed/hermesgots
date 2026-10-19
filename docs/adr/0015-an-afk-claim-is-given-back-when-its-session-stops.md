# An AFK claim is given back when its session stops

AFK holds one task per project, and a hold lasts exactly as long as the run working it. When a run
finishes, the project lets go of the task but leaves the claim on GitHub — the work is in review, and
taking the claim off would put the issue back in the frontier for the next sweep to pick up again.
When the user closes the session — discarded, resolved, or deleted — the claim comes off, because the
user has said that work is over. A start that never gets its run away gives the claim back too.

Giving a claim back is the whole of it, which is both marks: Gots's label *and* its own assignment.
A task is out of the frontier while it carries either, so taking only the label off would leave the
task in a state no sweep can take — released in name and claimed in fact.

The hold is the host's own row (`project_afk`), so it has to survive things the run doesn't: the
process restarting, the user closing the session from another device, the plugin being reloaded. That
is why the session's id is written on the row before the run is posted, why the reason a run stopped
is recorded there, and why closing a session is read from the chat list — the app's own record of
discard and resolve — rather than from a route, which only a device that was there would call.

A claim nothing is working is the state worth reporting. The session keeps its transcript, its
worktrees and its claim, and the project records why nothing is running it; `runs/live` then carries
that session as `{ kind: "stalled", reason }` beside the questions and approvals it already reports,
so the sidebar's Waiting for input and Code's Waiting on you name it with the host's own words. A
failed run says "The run failed." at once; a run that stopped without failing — a turn that ended, a
limit reached — says `DEFAULT_STALL` rather than calling itself a failure, since the host would be
inventing a reason. A session a restart adopted says so once the claim has had `STALL_SECONDS` to
become one, since a start still making its worktrees looks the same as a stall from outside; that is
why the clock is restarted when the start is done rather than left at the claim.

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
  future sweeps from taking a new task. A hold already taken is still settled — the switch is not what
  decides that a claim comes back — so a project switched off mid-run is swept for its hold alone.

## Consequences

- The row keeps three more columns (`session_id`, `stalled`, `stalled_at`, schema v26), so a restart
  can adopt the session it was working rather than start a second one on the same task.
- Releasing is best-effort on GitHub: a refusal is recorded for the sheet and the hold is dropped
  anyway, since nothing on the host is working the task either way.
- A sweep that gives a task back claims nothing in the same pass: the task the user walked away from
  waits for the next sweep rather than being handed out again the moment they closed its session.
- A hold naming no session — a row claimed before the column existed, or a start killed between the
  claim and its session — is given back once it is older than `STALL_SECONDS`, because nothing on the
  host can be working it.
- The user's Discard or Resolve on an AFK session is a decision about the task, not only the session:
  the claim comes off and the task returns to the frontier, where the next sweep may take it again.
