# A pick count is a number of places, and the holds past it are Queued

Two reports from the same sheet, both from AFK looking like it ignored its pick count.

**The sheet could draw more tasks than the count.** A hold is a place, and `places = pick count −
holds` clamps at zero, so a project whose count was lowered kept every hold it had: set to one with
three held, the Working block read "3 of 1 held". A hold whose run stopped keeps its place as well
(ADR 0015), so nothing drained it. The count read as a number the project could sit above.

**The same task was drawn twice.** `groups()` calls a task claimed when it carries an assignee *or*
Gots's own claim label, and every task AFK holds carries that label — so every held task had a second
row under Claimed, with the bot's own account named as the claimant. A group whose rows are mostly the
same tasks again is a second view of Working, not a fact of its own.

The rules that follow:

- **The count is the number of places the sheet draws.** The Working block draws the first `count`
  holds, oldest first, and counts those against the count. Holds past it get a **Queued** section
  directly under it — the tasks a lowered count left in flight, waiting for a place — so the project's
  sheet is the count the user set and nothing of it goes unsaid.
- **Lowering the count still abandons nothing** (ADR 0025). No hold is dropped and no claim is
  released: the row is also the record that releases the claim — the sweep's settled holds, a deleted
  project's, and a start that never got away all walk holds — so giving one back for a lower number
  would leave a task claimed on GitHub with nothing that would ever release it. The surplus finishes,
  and the next pass fills to the count.
- **The sheet has no Claimed group.** Its rows were AFK's own tasks (Working, or a session in Code once
  the work is in review) and, in the remainder, tasks another hand has taken — which AFK will never
  pick and which GitHub itself already shows. Neither belongs on this sheet, so the group is gone
  rather than narrowed.

## Considered options

- **Give back the surplus holds when the count is lowered.** Rejected: the hold row is also what
  releases the claim, so a dropped row leaves a task claimed with nothing to release it, and the
  stalled report can no longer find the session that is waiting.
- **Give the surplus claim back too.** ADR 0025's rejected option: it returns work that may already
  have a draft pull request to the frontier, to be claimed again.
- **Draw the surplus in one muted line under Working** (the first cut of this change: "2 more claimed
  above the count"). Rejected on a read of the screen: a count in prose is not a list a reader can act
  on, and the tasks are real work with sessions of their own. Queued says what they are waiting for.
- **Keep Claimed as somebody else's tasks.** Rejected: it was the one thing the sheet showed that
  Working could not, but it is not AFK's information — GitHub's issue list is where a hand on a task is
  read, and this sheet is the project's.
- **Trim the Working block without saying where the rest went.** Rejected: the surplus is claimed
  work, and a reader who cannot see it has no way to tell a count from a lie.

## Consequences

- The sheet's groups are Working, Queued, Ready and Blocked. Working is at or under the pick count,
  always; Queued appears only while a project holds more than its count.
- Nothing changes on the host: no write, no released claim, no dropped session, so the paths that
  settle, release and forget a claim are untouched. `projects/{id}/tasks` still answers `claimed`, and
  the app no longer reads it: `ProjectTasks` carries `ready` and `blocked`.
- A task that carries the claim mark with no hold behind it — the state a GitHub release refused
  leaves — is drawn nowhere in the sheet; the project's refusal line is what says the release failed,
  and the task is still visible on GitHub and in the session that had it.
- The bot's pick budget counts hold rows, so a queued task counts against it: a project holding more
  than its count holds more of the bot's budget too, which is what "already claimed" means for the bot.
