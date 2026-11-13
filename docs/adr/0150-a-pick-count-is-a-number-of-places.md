# A pick count is a number of places, and Claimed is somebody else's work

Two reports from the same sheet, both from AFK looking like it ignored its pick count.

**The sheet could draw more tasks than the count.** A hold is a place, and `places = pick count −
holds` clamps at zero, so a project whose count was lowered kept every hold it had: set to one with
three held, the Working block read "3 of 1 held". A hold whose run stopped keeps its place as well
(ADR 0015), so nothing drained it. The count read as a number the project could sit above.

**The same task was drawn twice.** `groups()` called a task claimed when it carried an assignee *or*
Gots's own claim label, and every task AFK holds carries that label — so the sheet drew it under
Working and again under Claimed, with the bot's own account named as the claimant.

The rules that follow:

- **The count is the number of places the sheet draws.** The Working block draws the first `count`
  holds, oldest first, and counts those against the count. Holds past it — what a lowered count left
  in flight — are named in one muted line under the list, so the project's sheet is the count the
  user set and nothing of it goes unsaid.
- **Lowering the count still abandons nothing** (ADR 0025). No hold is dropped and no claim is
  released: giving a hold back is what frees the place *and* the record of the claim, and a task with
  neither a hold nor a session is drawn nowhere at all. The surplus finishes, and the next pass fills
  to the count.
- **Claimed means somebody else has it.** A task carrying Gots's claim label is AFK's own work, drawn
  in Working while it runs and in Code once its work is in review; `groups()` puts it in no group. What
  the group keeps is an assignee with no claim mark — a person, or another tool — which is the one
  thing Working cannot say. It draws no heading when nothing is in it.
- **The sheet holds that rule too.** A task the project's own answer names under `holds` is never
  drawn under Claimed, whatever the host's grouping said: a plugin from before this rule still
  answers AFK's own tasks as claimed, and one task in two places is the confusion being reported. The
  host's rule and the sheet's guard are the same sentence said at both ends of the wire.

## Considered options

- **Give back the surplus holds when the count is lowered.** Rejected: the hold row is also what
  releases the claim — the sweep's settled holds and a deleted project both walk it — so a dropped
  row leaves a task claimed on GitHub with nothing that would ever give it back, and it is drawn in
  no group on the way out.
- **Give the surplus claim back too.** ADR 0025's rejected option: it returns work that may already
  have a draft pull request to the frontier, to be claimed again.
- **Drop the Claimed group entirely,** as the report asked. It would have been the smaller change;
  kept for the one fact only it carries, since the report asked for the difference to be told if
  there was one (`#1038`).
- **Trim in the host and let the sheet draw what it answers.** Rejected with the first option: the
  host's answer is the only place a hold's claim is recorded.

## Consequences

- A project's Working block is at or under its pick count, always, and a project above it says how
  many tasks are finishing rather than drawing them against a count they no longer fit.
- Nothing changes on the host: no write, no released claim, no dropped session, so the code paths
  that settle, release and forget a claim are untouched.
- The sheet's Claimed group empties for a project whose only claimed tasks are its own. A task that
  carries the claim mark with no hold behind it — the state a GitHub release refused leaves — is
  drawn in no group; the project's refusal line is what says the release failed.
- The plugin's `projects/{id}/tasks` answers `claimed` with a different meaning, and the app draws a
  claimed row only for a task the project does not hold — so the two can't disagree in the one place
  a person reads them.
