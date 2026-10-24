# A bot works up to its pick budget across its projects

ADR 0025 gives every project a pick count, but the counts never met each other: eight projects on one
bot, each at one, are already eight sessions at once, and nothing at the bot's own level said how much
is too much. The bot now has a **pick budget**: one number, one to ten, default five, held on the bot's
own store and edited in the bot editor's Coding tab. A project claims only while its pick count and the
bot's remaining budget both allow — the lower of the two numbers is what the bot works — and when a
place frees, the oldest ready task across every project of that bot takes it, which is the frontier's
oldest-first rule read over the whole bot instead of per project.

The rules that follow:

- **The budget counts holds, not runs.** A hold is a task claimed and kept until its work is in review
  (ADR 0025), so a stalled hold counts against the budget exactly as against the pick count: it is
  still the bot's claimed work, and giving the task back is what frees the place. Five stalled holds
  across five projects stop the bot claiming, and the refusal line says so.
- **Lowering the budget abandons nothing** — the same rule as lowering a pick count: what runs
  finishes, and the next claim waits for a free place.
- **A sweep held back by the budget records a refusal** on each project it would have claimed for, in
  the host's own words, and the budget is answered on the project's own read, so the pop-up's one read
  draws the usage line ("Pick budget 3 of 5") beside the pick count.
- **The budget is read once per pass, before any GitHub read** — the bot's holds are counted from its
  own store; a sweep never asks GitHub how full it is.

## Considered options

- **No bot number — pick counts alone.** Rejected: pick counts are per project, so a bot's total was
  whatever its project list added up to, and nothing at the bot's level could say "enough".
- **The budget as a default projects inherit.** Rejected: it is a ceiling over projects that already
  have their own pick counts, not a starting value; inheritance would make one number do two jobs and
  make one project's edit reach into another's.
- **Counting live sessions instead of holds.** Rejected: ADR 0025 made the slot the task — counting
  runs would free and retake places between stages, the exact trouble a pick count exists to avoid.
- **Letting the sweep's project order decide free places.** Rejected: a second fairness rule beside
  the frontier's oldest-first would mean iteration order decided whose work waited.

## Consequences

- Schema v39 in one bump: the holds table and `pick_count` ADR 0025 specifies, a settings row for the
  bot's pick budget, and `prompt_id` on `project_afk` for ADR 0043. ADR 0025 is amended where its
  schema line had gone stale.
- A bot-level `GET`/`POST /afk` beside the project's own routes — the route ADR 0026 already named —
  its fields also answered on the project's read so one read still draws the sheet. ADR 0026 is
  amended in part: the one flag it reserved as `afk_parallel` is `afk_picks`, which gates the pick
  count, the Working list and this budget together.
- The app gains a Coding tab in the bot editor and a pick count stepper under the AFK switch. The
  project's read keeps answering `task` as the oldest hold, so an app already shipped still draws its
  one Working row unchanged.
- Sweeping counts holds across the projects of one home; each bot's own store carries its own budget,
  so bots never share one.
