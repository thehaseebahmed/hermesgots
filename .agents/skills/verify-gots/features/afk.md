# AFK

AFK (Away From Keyboard) lets a project work its own tasks from GitHub while no one is watching. A
project's options menu carries the AFK row where its Host advertises `afk`; the pop-up titled
"Away From Keyboard" holds the project's switch for working on its own, the task AFK is holding, the
reason GitHub last refused the sweep, and the task frontier — ready oldest first, claimed ones marked
with who has them, blocked ones naming their open blocker.

## Sub-features

- `afk-frontier` — the pop-up lists the project's tasks as the frontier AFK reads, with no row where
  the feature is missing and the Host's own refusal in place of a list (`afk`).
- `afk-switch` — the switch turns the project on and off on its Host; a reload reads the Host's
  setting back, not the device's (`afk-switch`).
- `afk-switch-reasons` — where the switch can't be offered it shows off and disabled with the reason
  said once (no GitHub account; a plugin too old to switch) (`afk-switch-reasons`).
- `afk-skills` — the pop-up picks one skill to build by and any number to critique, kept on the Host
  apart from another project's (`afk-skills`).
- `afk-prompt` — the Prompt row reads the words the runs are told and opens one writing sheet for
  them (`afk-prompt`).
- `afk-claim` — turning a project on has the Host claim the oldest ready task: the pop-up names what
  AFK holds and the frontier no longer offers it (`afk-claim`).
- `afk-stage` — the pop-up names the stage the held task is in, prefixed to its title (`afk-stage`).
- `afk-session` — the claimed task is worked in a session of its own, marked AFK in Code
  (`afk-session`).
- `afk-stalled` — a stalled session waits where the user finds it: the sidebar's `Waiting for input`
  and Code's `Waiting on you`, with the Host's reason under it (`afk-stalled`).
- `pipeline-pill` — a staged session's pipeline is the first pill above the composer, with the sheet
  naming what each stage ran (`pipeline-pill`).

## How to get to it (user POV)

- A project's screen → `Project options` (its options menu) → the `AFK` row.
- The pop-up: the `Work on its own` switch, the task held, the frontier list.
- Code: a session marked AFK; a stalled one under `Waiting on you`.
- The sidebar's `Waiting for input` for a stalled AFK session.

## Driving it with the e2e flows

Preconditions:

- Baseline state (features/README.md). A project must be **cloned** before its screen offers the
  options menu: `makeProject(until, name)` creates one on the mock and waits for `status: "ready"`.
- The mock answers `GET projects/{id}/tasks` with the frontier and `GET projects/{id}/afk` with the
  switch and skills; `POST /__mock/afk` is the dev handle that stalls a held task at a stage and
  writes a pipeline (`{ project_id, stage?, reason?, pipeline?, pr?, reset? }`).

- **Open the frontier.** From a cloned project's screen open `Project options`, then `AFK`. Run
  `pnpm e2e afk --shots "$GOTS_VERIFY_ARTIFACTS/<run-id>"` (from `app/`; `openAfk(page, screen)` is
  the same taps: `getByRole("button", { name: "Project options" })`, then
  `getByRole("menuitem", { name: "AFK" })`). The pop-up lists ready tasks oldest first, claimed ones
  marked with who holds them, blocked ones naming their open blocker; a Host that can't read them
  shows its own refusal instead of a list, and a plugin without `afk` offers no row at all.
- **Turn it on.** Run `pnpm e2e afk-switch`. The `Work on its own` switch reads `Turned off` /
  `Turned on`; after a reload the row reads the Host's setting back — the project's, not this
  device's.
- **Why not.** Run `pnpm e2e afk-switch-reasons`. A project with no GitHub account shows the switch
  off and disabled with the reason under it (said once, not repeated for the frontier); a plugin that
  lists tasks but never advertised `afk_switch` has no picker but still switches.
- **Skills and Prompt.** Run `pnpm e2e afk-skills` and `pnpm e2e afk-prompt`. One build skill and
  any number of critique skills come from the bot's own live list and survive a reload on the Host;
  the Prompt row reads the words and `Done` writes them back (a Host that refuses leaves them as
  typed).
- **Claim.** Run `pnpm e2e afk-claim`. Turning the project on claims the oldest ready task — the
  pop-up names what AFK holds, the frontier no longer offers it, and a GitHub refusal leaves the
  switch on with its reason shown.
- **Stage and pipeline.** Run `pnpm e2e afk-stage` and `pnpm e2e pipeline-pill`, driving the stage
  with `POST /__mock/afk` (`say({ project_id, stage, ... })`). The pop-up prefixes the held task's
  title with the stage's own name from its snapshot; the pipeline pill above the composer carries
  three bars (green done, blue in, red failed, grey to come) and its sheet counts the stage out of
  three and names what each step ran — still there after the task finishes.
- **Session and stall.** Run `pnpm e2e afk-session` and `pnpm e2e afk-stalled`. The session opens
  from Code marked AFK with one line naming the task; a stalled one waits under `Waiting for input`
  and `Waiting on you` with the Host's reason under it.
- **Proof of a whole pass.** `afk-*.png` at 390 and 1024px, light and dark where claimed, and the
  Host's state read back (`GET projects/{id}/afk`) after any switch or pick write.

## Gotchas

- The options menu appears only once the mock has finished cloning the project — always drive
  through `makeProject(until, name)` or an equivalent wait on `status: "ready"`, never straight after
  the create call.
- The switch's state lives on the Host. A reload reading it back is the proof; the switch's own
  `aria-checked` after a click is only the write's echo. `afkOn(page, screen, until)` waits for the
  read-back.
- Turning a switch on wakes a sweep on the Host, so the claim lands *after* the switch's answer: wait
  for the task to move between groups (the pop-up re-reads when the answer names a task), not for a
  fixed time.
- The mock keeps AFK state per project **in its process**; a project id from an earlier run is not
  this run's. Use `makeProject` names carrying `runId()`.
- The frontier's ordering is the claim rule (ready oldest first). Assert order, not just presence.
- A plugin that predates a picker shows no picker — that is the mapped behavior
  (`afk-switch-reasons`, `afk-skills`), not a missing control to fail on.
