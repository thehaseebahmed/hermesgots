# A task is built, gated and critiqued, and the host runs the gate

An AFK task was one run: one agent read the issue, implemented it, ran the repo's gates and shipped a draft
pull request. Everything that decided whether the work was finished was that agent's own word, and nothing
reviewed the change before the user did. A project that picks one or more critique skills now works its
tasks in stages — a build run, a gate the host runs, a critique run, and the pull request opened last — and
the stage boundary is the host's, not the model's.

The gate is what makes the stages mean anything. The build run calls a plugin tool with the commands it
means to verify with; the tool runs them in the session's worktree and answers with their exit codes, so
"green" is something the host observed rather than something the run said. A gate passes when that call was
made, every command exited zero, the run ended without failing, and the worktree holds commits and nothing
uncommitted. Anything else stalls the task with its claim kept and the failure named, the way a failed run
already does. The build run is told to stop at the gate, and the plugin refuses the `pull_request` tool's
`ship` action while the session is building — a run that has shipped has nothing left to gate.

The critique is a second run on the same session. It delegates one reviewer per critique skill the project
picked — unless a skill prescribes its own arrangement, in which case the skill's own words win — each given
the task's issue, the base branch and the worktree, so the eyes are fresh rather than the author's opinion of
itself. The session fixes what it accepts in one pass, and the pull request is shipped from that stage with a
section saying what the critique found and what changed because of it. There is no second review: the user's
own read of the pull request is the next pass, and a loop that re-reviews its own fixes would only hide that.

The pipeline is opt-in. A critique skill is what turns it on: with none chosen, AFK is one run as before, and
a build skill only shapes how that run works. A skill governs method and never AFK's fixed points — read the
issue, verify, ask nobody, ship last — so no skill can unlock a gate. The choices are the project's, written
on its AFK record and chosen in the AFK pop-up, because the pipeline is the switch's behaviour rather than
the bot's. The stage lives on the session's own record rather than on the hold, which is released when the
run ends, so a session can still say how it got here after its task is finished.

## Considered options

- **One run, with the prompt telling the agent to implement, stop at the gate and review.** Rejected: the
  gate and the review then rest on the same agent's promises — a run that decides it has verified can ship,
  and a run that reviews itself finds nothing.
- **Two sessions, the critique in its own session and worktree.** Rejected: the fixes belong to the work the
  build did, in the transcript the user takes over, and a second worktree would need a merge nobody asked
  for.
- **A person's approval at the gate.** Rejected: AFK exists so the user can be away. A gate that waits for a
  tap is the stall the switch removes, and ADR 0011 already says Gots answers nothing in the user's name.
- **The run declaring which gates it ran, with the host recording the claim.** Rejected as the only check: a
  claim is not evidence, and the one thing a gate must not do is pass because the thing it gates said so.
- **Re-review after the fixes, until a pass finds nothing.** Deferred: one pass is the version whose cost and
  stall behaviour are understood; a loop needs a cap, a cost story and a way for the user to see why two
  rounds disagreed.

## Consequences

- A staged task costs two runs and re-runs the repo's gates through the host. A project that wants one run
  back clears its critique skills.
- A gate that fails, a build that never calls it, and a critique whose run fails all stall the task with its
  claim kept, so the user finds it in Waiting for input rather than having it handed out again.
- The gate's commands are the build's own choice, read from the repo; a call naming no command is refused,
  and a project whose gates it documents differently gets exactly what its build named.
- A chosen skill that disappears stalls the sweep rather than the run: the switch stays on and the reason is
  recorded, so a stale choice is visible instead of silent.
- The prompt's fixed text grows by two stage blocks, each constant so the prompt cache holds across a run's
  turns, with the chosen skill named in one line beside them rather than quoted.
- The pipeline's record has to outlive the hold, so it is written on the session's row and read back for a
  finished session — the strip and the pop-up's Working row read the same record.
