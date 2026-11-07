# AFK works one prompt run, and the workflow machine is removed

Status: accepted 2026-11-06, and the code that lands with it is at
[the plan](../plans/2026-11-06-afk-one-run.md).

AFK Workflows grew a second machine beside AFK: a bot-held library of named workflows and presets, a
picker behind a developer setting, a workflow's stages of steps, checkpoints and loops, a snapshot of
that workflow written onto the task's session before its first run, a gate the host ran over the
commands a stage named, findings a review reported, and a pill above the composer drawing which
stage the task had reached. ADR 0020 made it the default shape, ADR 0027 then made one prompt run the
default and left the library off by default — so what remained was a machine nobody had to use, whose
vocabulary (stage, round, step, checkpoint, loop, shipping stage, rewind) every AFK bug report and
every prompt had to speak.

None of it stays. AFK's own shape is what survives, and it is what ADR 0027 already made the default:
a project's switch on its host, its ready tasks claimed oldest first up to its pick count within its
bot's budget, each held task worked in one run told by the project's Prompt, a stall where the user
finds it, and one draft pull request. The library, the editor, the picker, the Developer setting, the
stage engine, the gate and findings tools, the snapshot and the pill are deleted; `afk_skills`' build
and critique pickers go with the columns behind them, since the host never advertised them and the
Prompt names its own skills in its own words.

Leaving it behind its setting was the alternative, and it is the one ADR 0015 already rejected for
goal mode: a feature a host advertises is a promise it has to keep, so a switch in front of a feature
is maintenance wearing a switch — and here the maintenance is the stage engine, which exists only to
run a workflow. Keeping the stages and deleting only the library is worse still: a workflow is the
only thing that builds a pipeline, so the engine would be dead code with a shape nobody can exercise.
"A workflow to a Prompt" was also refused: a library entry is stages and skills, a Prompt is one
method, and inventing the translation is a new feature inside a removal.

The cut is a wire cut, ADR 0015's shape. Routes, features, tests, browser flows and the docs that
describe them are deleted, `info.features` stops listing `afk_workflows` and `afk_pipeline`, and no
route answers "removed". An older app build draws no Workflow row and no pill because the features are
gone, and a build that still posts a workflow pick gets the 400 an unknown write shape has always
answered with. One schema step — v58, in the store's existing transaction — carries every pre-v40 held
task into `holds` first, rebuilds `project_sessions` without `pipeline` and `project_afk` without
`workflow_id`, `build_skill` and `critique_skills`, drops the `workflows` table, and leaves the
switch, the Prompt, the holds, the pick count and the budget as they were. A project that had picked a
workflow runs its own Prompt, or the bot's default where it wrote none; no Prompt is derived from a
workflow. The prompt's section heading stops being `## User's Workflow` and becomes
`## The Project's Prompt`, the last workflow word a run was told.

## Consequences

- A project that picked a workflow and wrote no Prompt changes method on upgrade, from its stages to
  the default method. The only thing on screen that says so is the Workflow row disappearing.
- A one-run task no longer stalls for ending without a pull request: that rule judged the stage that
  ships, and a one-run task frees its hold instead. Every task that never picked a workflow already
  behaved this way.
- A task mid-stage when the host upgrades loses its remaining stages; the run that ends after it is
  settled as a one-run task, the claim stays on GitHub, and its work stays in the session.
- `afk_gate` and `afk_findings` leave the toolset, so a run told to call them by an old transcript gets
  a missing tool rather than a refusal.
- The plugin's version moves with the code; `MIN_PLUGIN_VERSION` stays, since the app now asks the host
  for less than it did (ADR 0015's floor).
- Workflows can come back on a different footing — a judge, a review loop, a method the user edits —
  without carrying this one's snapshot, rounds, gate record or stage vocabulary, and nothing in the
  app or the store names them until that decision is taken.
