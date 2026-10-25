# Gots verification map

This directory is the maintained source for verifying the user-facing behavior of Gots, the Hermes
companion PWA in `app/`. Read this index before driving the app, then use the matching feature file
as the recipe. `../SKILL.md` is the run contract (launch, doctor, drive, evidence, cleanup).

## Baseline preconditions

- `pnpm install` has been run in `app/` and `app/node_modules` exists.
- `pnpm e2e up` has brought up the app on `http://localhost:15173` and the mocks (18642 `live`,
  18643 `polling`, 18644 `legacy`, 18645 `no-dictation`), or a flow is letting the CLI start them.
- `.agents/skills/verify-gots/doctor.sh` answers exit 0 and names this worktree's pids.
- Every drive opens a fresh browser profile (empty IndexedDB; Dexie migrates on first touch) with
  the first bot pointed at the mock. Seeded projects `p_1a2b3c4d` (Gots) and `p_9c0d1e2f` (Smart
  Home, two repos) come from the mock itself.
- Never drive an instance this verification run did not start. With `--jobs`, each lane owns its
  own mock ports and nothing else may be driven on them; a lane costs a browser (~150 threads), so
  size `--jobs` to the machine — `doctor.sh` reports the cgroup's thread budget.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position: the recipes name the
  handle the app renders (`getByRole("button", { name: "Allow once" })`, the `Recents` navigation,
  the `Waiting on you` region).
- Treat every command as literal. Keep quoted names, message words and flags unchanged — the mock
  answers behavior from words in a message (`clean up`, `ask`, `plan`, `long`).
- Run browser actions through a flow on `app/scripts/e2e/lib.mjs` (see `../SKILL.md`, **Drive**).
  A registered flow is one `pnpm e2e <flow>` command from `app/`; its steps are listed in the
  feature file so a drive can assert the same states ad hoc.
- Restore mock state a mutation disturbed (`POST /__mock/mcp` puts removed MCP servers back).
  Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes `shot(step)` screenshots at each state a reviewer would want, at the widths the
  journey claims, with the run's transcript of `PASS:` lines.
- Mutation proof includes a read-only second view of the stored value: a reply row in Dexie
  (`lastReply`), an AFK switch read back from the Host after a reload, a removed server gone from
  the list.
- Record the feature ID and entry point used with every artifact (they land in
  `$GOTS_VERIFY_ARTIFACTS`, never in the repo).
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It
then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the e2e flows` starts with `Preconditions:` and uses labeled bullets that pair
   each user action with an exact command or helper call and its observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state,
commands, and observable proof.

## Features

- [Chat](./chat.md) covers sending a message, the reply's arrival, Recents, drafts, a failed send
  and a reply that survives a reload.
- [Bot threads](./threads.md) covers a bot opening on Main with its threads as cards at their start
  times, opening a card and sending from one, `/thread`, a message that opens a thread, one moved
  into an older thread, the cards at tablet width in the dark theme, and the three columns a laptop
  keeps — Main beside the thread last opened for that bot, or the line that says it has none.
- [Approvals and questions](./approvals.md) covers what waits on the user: approvals in the sidebar
  and Code, allowing them, missed ones, and questions answered across reloads.
- [MCP servers](./mcp-servers.md) covers a Bot's MCP page: rows and health, gating, adding from the
  header's `+` — the Catalogue or by hand — one server's Config and Tools, removal and Server access.
- [AFK](./afk.md) covers a project working its own tasks: the frontier, the switch and its reasons,
  the skill pickers and Prompt, claiming, the AFK session and a stalled one.
- [Research](./research.md) covers a research mission from question to guide: the brief, the Scope
  Gate, delivery, another format and citations.

Not yet mapped (their flows exist — add a file here when they are verified through one): meetings,
onboarding and recovery codes, pull requests and outputs, dictation, panes and screen widths
(`screens`, `panes`, `sidebar-collapse`), history paging and generations, todos, model settings
(`fallback-models`, `delegation-model`, `model-switch`, `usage-limit`), images, Routines (no flow
yet — its screen is only reached by `pnpm e2e shot /routines` today).
