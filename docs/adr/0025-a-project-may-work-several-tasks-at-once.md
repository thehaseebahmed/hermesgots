# A project may work several tasks at once, up to its pick count

AFK held exactly one task per project. `project_afk` carries the task itself in its own columns — one
JSON row, the session working it, and why nothing is working it when that happens — and the sweep
reads the project's frontier, takes the oldest ready task, and does nothing at all while a hold is in
place. A project with ten ready tasks and a workflow that loops through a slow test suite therefore
works them one at a time, and each task's whole workflow holds the only place: Build, Test, Review and
Summary are four runs and one task.

A project now has a **pick count**: how many of its tasks AFK will hold at once, from one to five,
defaulting to one. The hold stops being a column and becomes a row: one per claimed task, carrying
the session working it and the stall record, so two tasks in flight are two ordinary rows rather than
a shape that has to grow a second representation. `project_afk` keeps the switch, the workflow pick
and the count.

The rules that follow:

- **A slot is the task.** One of the five is taken at the claim and kept until the task's work is in
  review, so a four-stage workflow does not free and retake its place between stages. The count is a
  budget of tasks, not of concurrent runs, which is what the user means by "how many at once" when
  they look at a list of ready tasks.
- **One pass fills every free slot.** With room for two and two tasks ready, a single sweep claims
  both, oldest first. Starting them is one after another, on the loop, because a start makes a
  worktree on the same repository and posting runs is the API server's own call; the counting is
  worth having without the starts racing each other.
- **Lowering the count abandons nothing.** A project dropped from three to one lets its three tasks
  finish and picks the next one when it is down to none. Releasing the surplus would put claimed work
  back in the frontier, where the same sweep — or a person — would pick it up again and start over on
  work that may already have a draft pull request.
- **A stalled hold keeps its place.** A task nothing is working waits for the user (ADR 0015), and it
  is still the project's work in flight; its slot goes when the task is given back.
- **Giving a task back gives back one row.** A session the user closes releases the task that session
  worked, not the project's others, and the sweep's own rule stands: a task given back in a pass is
  not claimed again by that pass.

## Considered options

- **Keep one row and let its JSON hold a list of tasks.** Cheapest to write, and it makes the stall
  record, the session it names and the claim's own clock plural inside one column — every reader of
  the row would have to unpick which task a session or a reason belonged to.
- **Keep the first task in the columns and put the surplus elsewhere.** Two shapes for one idea, and
  the sheet would have to read both.
- **A slot per run, or per stage.** Rejected: a task between two stages would free its place, the
  sweep would take a new task, and a project with a count of two could end up with four tasks half
  worked — each between stages, none finishing.
- **Start the claimed sessions in parallel.** Rejected: `worktree` creation on a big repository is
  the expensive half of a start, and two of them at once on one repository is a load the user never
  asked for by asking for two tasks.
- **One claim per pass.** Rejected: a count of five would fill over four sweeps, three minutes apart,
  so turning the count up would look like nothing happened.
- **Release the surplus when the count is lowered.** Rejected above: it hands back work that is
  already under way.

## Consequences

- Schema v39 (v30 when this was written — that number was taken by `project_afk.prompt`, and the
  store is already past it): a holds table keyed by the task, with `project_afk` losing its `task`, `session_id`,
  `claimed_at`, `stalled` and `stalled_at` columns' meaning (their rows are migrated into it) — and
  gaining `pick_count`. A project's row written before the migration is one hold.
- **A session finds its project through the holds table**, so `holding_project`, `release_session` and
  the stalled report read it rather than the project's row; a hold naming no session is still given
  back once it is older than `STALL_SECONDS`.
- The sheet's Working block becomes a list, one row per held task with the stage it is in, and it
  gains the count row. The task list under it is unchanged: a claimed task is marked by GitHub, and
  now there may be several.
- `STALL_SECONDS` measures a hold, and each hold has its own clock: a second task claimed in the same
  pass is not made to look stalled by the first one's age.
