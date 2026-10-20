# A workflow is the bot's, and a task keeps the one it ran

A workflow is picked per project and edited in AFK's pop-up, but it is not the project's: it lives in
a library the bot holds, beside the presets it ships with. Several projects can work under the same
workflow — "Build · Test · Review" is one thing, not five copies of it — and a fix to it reaches all
of them. Editing a preset forks it into a copy of the bot's own, so the preset a later plugin version
changes is still the preset, and a project that was working under it says so.

When a task starts, the workflow as it stood is **snapshotted onto the session's record**, and every
read afterwards — the pill, the sheet, the pop-up's Working row — comes from that snapshot. The
library can be edited, renamed or even emptied later; what a finished task says it ran cannot change.

Deleting a workflow a project names is refused, and the refusal names those projects. The sweep runs
with the app closed, so a project pointing at nothing has to mean something specific, and the two
candidates were both worse: falling back to the default preset silently changes how a project works
without the user asking, and carrying on with a deleted workflow's last copy leaves the picker unable
to say what the project is doing.

## Considered options

- **One workflow per project, presets copied into the project on first pick.** Rejected: no sharing
  and no fix reaching five projects at once, which is what "pre-configured workflows" is for.
- **A library plus a project-level fork.** Rejected: two places the same name can mean different
  things, and nothing a user can see says which one runs.
- **The session keeps only the workflow's id and its stage.** Rejected: an edit to the library would
  rewrite what a finished task says it ran — the sheet would grow a stage the task never reached,
  and lose one it did.

## Consequences

- The library is the bot's, on the host, in the plugin's store: it does not sync between devices, the
  same as the switch and the pipeline it drives.
- A workflow that nothing names can be deleted; the ones a project names refuse it, listing them.
- A preset's name is stable across plugin versions, and a fork is a new entry the user names.
- The session's record grows: a workflow snapshot, a row per stage, and a row per loop round.
