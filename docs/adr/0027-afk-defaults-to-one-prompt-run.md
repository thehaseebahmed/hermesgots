# AFK's default is one prompt run, and workflows are the opt-in

ADR 0020 made staging the default: a project that picked nothing ran Build · Test · Review · Summary,
four runs of its session, with the workflow library and its picker on screen. That was more machine
than the problem needed. What a project actually has is one instruction — how its work should be
carried out — and a library of stages, presets, loops and a picker to say it. So a project with no
workflow now runs **one run**: the fixed brief, then the project's **prompt**, and that is the whole
shape. The workflow library stays where it is, behind a developer setting in the app that is off by
default, and picking a workflow is what turns the machine back on.

Three things follow from that, and each was a choice:

- **The prompt is the project's, and lives on the host.** It is text on the project's AFK row, not a
  device setting, because the sweep that works the tasks runs with the app closed. It starts as the
  bot's default method, is edited in the app, and an empty value means the default again.
- **The fixed brief stops being a method.** It keeps only what no prompt or skill may override — the
  issue is the spec, nobody is there to ask, the pull request ships last, nothing is merged or
  closed, no secrets — and the sentence saying so. Read, plan, implement, verify, ship, report moves
  into the default prompt, where a user can change it, and a skill applied beside it changes how a
  checkpoint is built without changing whether it is checked.
- **The first message of an AFK run quotes the issue.** It is the title, the description and the
  issue link, in the run's input, instead of ADR 0011's one line naming the issue for the agent to
  fetch. The description is what the change is judged against, and a run that has to fetch it can be
  wrong about it in a way nobody reads until the pull request is open. The fixed brief keeps its
  cache because the body rides in the message, not the instructions.

## Considered options

- **Keep the staged default and only hide the pickers.** Rejected: the default would still spend four
  runs on every task, and the screen would be hiding the shape of the work rather than simplifying
  it. Hiding a default is not the same as not having one.
- **A flag on the bot's host, written when the developer setting flips.** Rejected: the setting
  decides what this device draws, and the host already holds the answer in the project's own row —
  no pick means one prompt run. A bot-wide flag adds a second source of truth for a view preference.
- **A mode column beside the pick** (`prompt` or `workflow`). Rejected: it records something the row
  already says. Saving a prompt clears the pick, so a project is never both, and nothing can drift.
- **Delete the workflow library.** Rejected: it works, it is tested, and it is the shape some
  projects need. A setting that is off by default costs the people who don't want it nothing.
- **The prompt replaces the brief.** Rejected: the brief is AFK's own fixed points — no gate is
  answered for the user (ADR 0011), the pull request is shipped last, merging is theirs — and those
  are not the project's to edit. The prompt is the method; the brief is what the method may not
  change.

## Consequences

- A project that never picked a workflow ran four runs before this and runs one after. That is the
  point of the change, not a migration to soften: a task already holding its work keeps the snapshot
  it started under.
- `workflows.pick` stops answering the staged preset as a default. The read names the **One run**
  preset for a project that has picked nothing, so the app's picker has something true to show, and
  the sweep posts no pipeline snapshot for it — the one run is not a stage.
- A prompt-mode task has no pipeline, so its session draws no pill and no details sheet. A staged
  task keeps both, and a device that turns workflows off still draws what the host recorded.
- The library is unreachable from a device whose setting is off, and the app writes nothing about
  it: a project on a pick keeps running it until someone picks another workflow for it.
- An older plugin advertises no `afk_prompt`, so the app draws the sheet it draws today until the
  host is upgraded.
- The default prompt carries no learnings file: Theseus keeps one because a server holds it, and
  there is no server here. What a run learned lands in the pull request body, beside what it did.
