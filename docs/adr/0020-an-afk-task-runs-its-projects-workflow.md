# An AFK task runs its workflow's stages, and the workflow is data

An AFK task's stages were fixed in code: `pipeline.STAGES` was Build, Gate, Critique, and a project
turned the pipeline on only by picking a critique skill (ADR 0018). That shape was the whole machine —
a project could not name a stage, could not give a stage more than one skill, could not add a stage
after the review, and could not ask for work to be repeated until it passed. A project now has a
**workflow**: an ordered list of named stages, each with the skills it applies and, optionally, a span
that repeats. Build, Test, Review and Summary stop being code constants and become one workflow among
the presets the bot ships with.

The engine is small, and every rule in it is the host's:

- A **stage** carries a name, its **steps** (skills, in order) and an optional check. A stage with
  steps posts one run of the task's session, and that run applies its skills in order: a stage with
  three skills is three lenses in one run, not three runs.
- A stage with no steps but a check is a **checkpoint**: the host answers it from what the previous
  run already left behind, and posts nothing. Today there is one check — the gate, whose exit codes
  the host ran itself — so the preset's Build · Test is one run and one free judgement.
- A **loop** marks a span of stages and repeats it while the checkpoint ending the span fails, up to
  the cap the workflow sets (1–10, three in the preset); on the last round it stalls the task naming
  the failed command. The next round's build brief carries that failure, so it knows what to fix.
- Exactly one stage is the **shipping stage**, and only its run may call `pull_request` with `ship`;
  every other stage's run is refused it with the stage named. The preset sets it on Review, and
  Summary runs after the draft exists — a wrap-up that fails therefore cannot cost the pull request.
- A stage's **built-in brief** is what it does with no skills at all, so a preset works on a fresh
  project: Build implements the issue, Test gates it, Review reviews the diff, Summary wraps up. A
  skill refines a stage's method and never its fixed points.

**Staging is now the default.** A project that has picked nothing runs the default preset
(Build · Test · Review · Summary) rather than one build-and-ship run, which reverses ADR 0018's
opt-in: the gate exists to make a review safe, and a review is worth having by default. A project
that wants the old behaviour picks the **One run** preset, which is the same single run AFK has
always had. The presets ship read-only and fork when edited (ADR 0021). A project whose stored build
and critique skill columns hold something is read as the workflow they describe, written once, so no
project changes how it works just by upgrading.

The review no longer delegates. ADR 0018 had the critique spawn one reviewer per critique skill, with
a brief of its own, on the argument that a run reviewing itself finds nothing. The instruction was
the wrong place for that judgement: a skill that wants reviewers says so in its own words, and one
that reads the diff carefully does not need a child agent to do it. So the review stage posts an
ordinary run on the task's session, tells it which skills to load and apply, and says nothing about
`delegate_task` anywhere.

## Considered options

- **Keep the fixed three stages and only let the user rename them.** Rejected: the fixed machine is
  exactly what makes a Summary stage, a second skill in one stage, and a repeat-until-passing loop
  impossible to express — the four asks that started this.
- **One run per step.** Rejected: a review stage with three skills would cost three runs, and the
  fixes a review accepts would belong to whichever run happened last. Steps are lenses inside one
  run.
- **The whole task in one run, with stage boundaries as tool calls.** Rejected: the run's context
  would grow across every stage, the host would stop owning the boundary it judges at, and a stopped
  run would leave no stage to say where it stopped.
- **A Test stage that posts its own run to run the commands.** Rejected: a whole run spent to run
  commands the build already named, and a stall would land on a stage that only ran a shell.
- **Require a critique skill before a workflow runs** (ADR 0018's opt-in, kept). Rejected: a preset
  that needs configuring before it does anything is not "shipped with AFK", and the review stage's
  built-in brief makes an unreviewed task impossible anyway.

## Consequences

- A task costs at least two runs — Build and Review — and a third when Summary has a skill. The One
  run preset is the way back to one, per project.
- `pipeline.py` keeps the stage machine's rules but reads a workflow instead of constants: the
  record on the session becomes the workflow's snapshot plus a row per stage and round (ADR 0021).
- The app's pill and its sheet stop being three bars: they draw one bar per stage of the snapshot,
  and the sheet's title counts that workflow's stages rather than always three.
- The host's refusal of `ship` moves from "not the critique stage" to "not the shipping stage",
  which is the same refusal for the default preset and a general one for any workflow a user writes.
- A stage that ends without the checkpoint the next stage needs stalls the task with that stage
  named, exactly as a failed gate does today.
- Rows written before this read as a three-stage workflow snapshot with the old skills as their
  steps, so a finished task still says how it got there.
