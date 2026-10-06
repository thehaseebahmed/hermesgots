# Roadmap: a "Code" section for Memento

Status: proposal, not yet scheduled. Source: a feature audit comparing Hermes
Agent's built-in capabilities (worktrees, kanban, checkpoints, delegation,
cron) against Claude Code's "Code" tab, scoped to what's actually reachable
from a remote PWA client.

## Constraint that shapes every phase

Memento is a thin client to one already-running Hermes server. It can only
reach Hermes's deliberately narrow HTTP API server (`/v1/*`, a handful of
`/api/*` routes) and whatever the Memento plugin adds to it
(`/api/plugins/memento/...`, same pattern as the existing cron-runs route).

Everything interesting on the Hermes side — git worktrees (`hermes -w`,
`/worktree new`), Projects, the Kanban board, checkpoints/`/rollback`, and
subagent delegation (`delegate_task`) — is CLI/TUI/Desktop/dashboard-only
today. None of it has HTTP routes (confirmed by grepping
`gateway/platforms/api_server*.py` in NousResearch/hermes-agent). The
Kanban board's own REST routes exist but live on `hermes dashboard`
(port 9119, localhost-only, rotating session token) — the same wall
Memento's own `AGENTS.md` already documents for the Memento plugin.

So almost every phase below is "add a plugin route," not "wire up a
frontend." Phases are ordered by that cost, cheapest first.

## Phase 1 — Wire up what already has an API

No new Hermes-side work. Pure Memento frontend.

- [x] Add pause / resume / run-now buttons to `/routines`, calling the
      already-documented `POST /api/jobs/{id}/pause|resume|run`. Already
      shipped: each job's menu in `app/src/routes/routines.tsx`.

## Phase 2 — Read-only Project and Kanban visibility

New Memento plugin routes, read-only, mirroring the existing
`cron/runs` route shape.

- [x] `GET /api/plugins/memento/projects` — list the user's configured
      Hermes Projects (name, description, folders and which are git repos,
      last session time), read from `projects.db`.
- [x] Memento UI: a "Code" nav item listing every bot's Projects in one
      list, most recently worked on first (title, then description or git
      repos, with the bot as the icon).
- [x] Create a project with its GitHub repos, cloned on the Hermes host into
      `$HERMES_HOME/projects/<project>/` with the host's GitHub account.
- Deferred: `GET /api/plugins/memento/kanban/tasks` and a read-only task
      list on the Code screen (tasks across boards by importing `kanban_db`
      when the kanban plugin is installed).

## Phase 3 — Checkpoints/rollback viewer

- [x] `GET /api/plugins/memento/projects/:id/checkpoints` — list
      checkpoints with change stats, and a diff endpoint
      (`GET /api/plugins/memento/projects/:id/checkpoints/:hash/diff`).
      Keyed by project id, as the app already has it; each checkpoint's
      changes run to the next one, or to now for the newest.
- [x] New Memento frontend surface: a diff viewer (file list + unified
      diff), read-only to start. A Checkpoints tab on the project screen.
- Deferred: rolling back from Memento (Hermes's `restore()` has a safe
      mode that keeps hand-edited files; it needs the store lock).

## Phase 4 — Mutating Kanban from Memento

- [ ] `PATCH /api/plugins/memento/kanban/tasks/:id` — status transitions
      and task creation, routed through the same `kanban_db` layer the CLI
      and dashboard use, with the same concurrency care the existing kanban
      dashboard plugin takes.
- [ ] UI: status-change actions and a create-task sheet on top of Phase 2's
      list view.

## Phase 5 — "Start a coding session in a worktree" chore

The first genuinely new capability, not just a read/write proxy.

- [ ] `POST /api/plugins/memento/worktree-sessions` — given a Project and a
      natural-language task, call into `hermes_cli/worktree_ops.py`'s
      existing functions to create the worktree (don't reimplement worktree
      logic), then start a run scoped to that directory
      (`hermes -w -z "<task>"` or a directory-scoped `/v1/runs` call).
- [ ] Relay run events back through Memento's existing SSE/resume machinery
      in `chat.ts` — this part is close to free, it's the same resume model
      already built for chat turns.
- [ ] UI: "New chore" sheet (pick Project, type task, start) rendering as a
      pinned chat-style thread with a header showing branch + worktree path.
- [ ] On completion: surface commit count / branch name, with a keep/discard
      action that calls back into `git worktree remove` via the plugin
      (mirrors what a worktree-aware client does on exit).

## Phase 6 — Arbitrary GitHub repo picker

Bigger: Hermes itself has no "clone this GitHub URL for me" primitive —
worktrees assume the repo is already checked out on the host. This phase
needs new ground on both sides:

- [ ] GitHub OAuth scoped to repo listing in Memento (separate from the
      existing Netlify Identity GitHub sign-in, which only identifies the
      account owner today).
- [ ] A plugin route that clones a chosen repo onto the Hermes host before
      Phase 5's worktree-session flow can target it.

## Deferred / needs a decision before scheduling

These either depend on an upstream Hermes change, or duplicate a UI that
already exists elsewhere — worth tracking, not worth building yet.

- **Live subagent/parallel-workstream visibility.** `delegate_task` emits
  no SSE events today (not in Hermes's documented event list:
  `message.delta`, `tool.started/completed`, `reasoning.available`,
  `approval.request`, `replay.truncated`, `run.*`). Needs a change to
  Hermes's own gateway event schema — which, per Hermes's own contribution
  rubric ("the core is a narrow waist"), is the hardest kind of change to
  get accepted upstream, independent of Memento-side effort.
- **Full remote Kanban board parity** (drag-drop, auto-decompose, PR
  acceptance gating) rebuilt natively in Memento at phone width. Kanban
  already has a complete dashboard SPA for this; duplicating it in a PWA is
  a lot of rework for something that already exists one layer away. If
  this is ever wanted, revisit whether linking out to `hermes dashboard`
  solves it more cheaply than Phase 4 going further.
- **A true "Code" tab matching Claude Code's cloud environments**
  (ephemeral, fully server-managed sessions per task/repo, independent of
  one long-running host). Hermes's model is "one persistent gateway on a
  host, worktrees inside it," or the separate Hermes Cloud product (Nous
  Portal), which Memento has no hooks into. Matching Claude Code's model
  here is closer to a new product than a Memento feature — don't schedule
  without a separate scoping pass.

## Notes for whoever picks this up

- Every new HTTP route in Phases 2–6 goes in the Memento plugin
  (`plugin/`), following the existing `register_platform_handler("api_server", ...)`
  pattern — not into Hermes core, and not onto the dashboard.
- Update `app/scripts/mock-hermes.mjs` whenever a new route is added, per
  `AGENTS.md`.
- Phase ordering is by implementation cost, not by user value — Phase 5 is
  probably the actual product goal; Phases 1-4 are what make it buildable
  without a huge first PR.
