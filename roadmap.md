# Roadmap: a "Code" section for Gots

Status: proposal, not yet scheduled. Source: a feature audit comparing Hermes
Agent's built-in capabilities (worktrees, kanban, checkpoints, delegation,
cron) against Claude Code's "Code" tab, scoped to what's actually reachable
from a remote PWA client.

## Constraint that shapes every phase

Gots is a thin client to one already-running Hermes server. It can only
reach Hermes's deliberately narrow HTTP API server (`/v1/*`, a handful of
`/api/*` routes) and whatever the Gots plugin adds to it
(`/api/plugins/memento/...`, same pattern as the existing cron-runs route).

Everything interesting on the Hermes side — git worktrees (`hermes -w`,
`/worktree new`), Projects, the Kanban board, checkpoints/`/rollback`, and
subagent delegation (`delegate_task`) — is CLI/TUI/Desktop/dashboard-only
today. None of it has HTTP routes (confirmed by grepping
`gateway/platforms/api_server*.py` in NousResearch/hermes-agent). The
Kanban board's own REST routes exist but live on `hermes dashboard`
(port 9119, localhost-only, rotating session token) — the same wall
Gots's own `AGENTS.md` already documents for the Gots plugin.

So almost every phase below is "add a plugin route," not "wire up a
frontend." Phases are ordered by that cost, cheapest first.

## Phase 1 — Wire up what already has an API

No new Hermes-side work. Pure Gots frontend.

- [x] Add pause / resume / run-now buttons to `/routines`, calling the
      already-documented `POST /api/jobs/{id}/pause|resume|run`. Already
      shipped: each job's menu in `app/src/routes/routines.tsx`.

## Phase 2 — Read-only Project and Kanban visibility

New Gots plugin routes, read-only, mirroring the existing
`cron/runs` route shape.

- [x] `GET /api/plugins/memento/projects` — list the user's configured
      Hermes Projects (name, description, folders and which are git repos,
      last session time), read from `projects.db`.
- [x] Gots UI: a "Code" nav item listing every bot's Projects in one
      list, most recently worked on first (title, then description or git
      repos, with the bot as the icon).
- [x] Create a project with its GitHub repos, cloned on the Hermes host into
      `$HERMES_HOME/projects/<project>/` with the host's GitHub account.

## Phase 3 (optional) — Checkpoints/rollback viewer

- [ ] `GET /api/plugins/memento/checkpoints?project=<slug>` — list
      checkpoints with change stats, and a diff endpoint
      (`GET /api/plugins/memento/checkpoints/:id/diff`).
- [ ] New Gots frontend surface: a diff viewer (file list + unified
      diff), read-only to start.

## Phase 4 — The agent's todos in chat

The agent's own plan for a turn, shown read-only above the composer the way
Claude Code shows its task list. This is Hermes's per-session `todo_list`
tool, not Kanban: the agent writes and updates it, the user only watches.

- [x] `GET /api/plugins/memento/sessions/{id}/todos` — the session's latest
      `todo_list` result, read from its transcript (following compression).
- [x] Nudge the agent to plan: `todo_list` is a deferred tool by default, so
      each run sends a short `instructions` line asking for it on multi-step
      work.
- [x] UI: a "2/5 todos" pill above the composer that opens the list.

## Phase 5 — Project sessions

The first genuinely new capability, not just a read/write proxy: a chat
that works in its own git worktree of a project's repo.

- [x] `POST /api/plugins/memento/sessions/{id}/workspace` — makes the
      session's worktree with `hermes_cli/worktree_ops.py`'s own function
      and points the session's tools into it (`/v1/runs` has no cwd, but
      Hermes's terminal tool has a per-task cwd override keyed by the
      session id). Posted before every turn, restored by a hook after a
      gateway restart.
- [x] Run events come through Gots's existing SSE/resume machinery in
      `chat.ts`; nothing new there.
- [x] UI: "New session" on a project opens a chat with a two-line composer:
      the text, then `+`, the permission mode, the context ring, voice and
      send. The header shows the branch. A session spans every repo of its
      project (a worktree in each); repos are named `user/repo`, never by
      their path.
- [x] Permission modes per session, held by the plugin: Accept edits
      (Hermes's native behaviour), Auto (the app answers approvals) and Plan
      (the plugin's `pre_tool_call` hook blocks anything that changes a
      file; the finished plan waits for approval in place of the composer).
- [x] Session states on the project screen: Working, Waiting on you, Idle
      and Resolved, from the plugin's live-run list and this device's own
      turns. Resolve, Edit and Delete in the chat menu; a resolved session
      shows a notice in place of the composer until it's reopened.
- [x] The branch's pull request in each repo as a pill next to the todos
      pill (looked up on GitHub by the plugin), coloured by state and
      orange when its checks fail, and worktree removal on delete when a
      tree is clean and pushed.
- [ ] The Library and PRs tabs of a project.

## Phase 6 — Arbitrary GitHub repo picker

Bigger: Hermes itself has no "clone this GitHub URL for me" primitive —
worktrees assume the repo is already checked out on the host. This phase
needs new ground on both sides:

- [ ] GitHub OAuth scoped to repo listing in Gots (separate from the
      existing Netlify Identity GitHub sign-in, which only identifies the
      account owner today).
- [ ] A plugin route that clones a chosen repo onto the Hermes host before
      Phase 5's worktree-session flow can target it.

## Phase 7 — Composer context

What the `+` button on the composer (bot chats and project sessions) adds to a
message. It opens an **Add context** sheet with Camera, Photos and Files.

- [ ] Mention files from the project folder (a plugin route lists the
      worktree's files; picked paths go into the message as references the
      agent can read).
- [x] A photo from the camera.
- [x] Images from the gallery.
- [x] Documents from the device.

## Deferred / needs a decision before scheduling

These either depend on an upstream Hermes change, or duplicate a UI that
already exists elsewhere — worth tracking, not worth building yet.

- **Live subagent/parallel-workstream visibility.** `delegate_task` emits
  no SSE events today (not in Hermes's documented event list:
  `message.delta`, `tool.started/completed`, `reasoning.available`,
  `approval.request`, `replay.truncated`, `run.*`). Needs a change to
  Hermes's own gateway event schema — which, per Hermes's own contribution
  rubric ("the core is a narrow waist"), is the hardest kind of change to
  get accepted upstream, independent of Gots-side effort.
- **Kanban from Gots** (a read-only task list, then status changes and a
  create-task sheet through `kanban_db`). Kanban cards are shared, dispatched
  work on a board every profile sees, not a session's plan, so Phase 4 shows
  the agent's `todo_list` instead.
- **Full remote Kanban board parity** (drag-drop, auto-decompose, PR
  acceptance gating) rebuilt natively in Gots at phone width. Kanban
  already has a complete dashboard SPA for this; duplicating it in a PWA is
  a lot of rework for something that already exists one layer away. If
  this is ever wanted, revisit whether linking out to `hermes dashboard`
  solves it more cheaply than Phase 4 going further.
- **A true "Code" tab matching Claude Code's cloud environments**
  (ephemeral, fully server-managed sessions per task/repo, independent of
  one long-running host). Hermes's model is "one persistent gateway on a
  host, worktrees inside it," or the separate Hermes Cloud product (Nous
  Portal), which Gots has no hooks into. Matching Claude Code's model
  here is closer to a new product than a Gots feature — don't schedule
  without a separate scoping pass.

## Notes for whoever picks this up

- Every new HTTP route in Phases 2–6 goes in the Gots plugin
  (`plugin/`), following the existing `register_platform_handler("api_server", ...)`
  pattern — not into Hermes core, and not onto the dashboard.
- Update `app/scripts/mock-hermes.mjs` whenever a new route is added, per
  `AGENTS.md`.
- Phase ordering is by implementation cost, not by user value — Phase 5 is
  probably the actual product goal; Phases 1-4 are what make it buildable
  without a huge first PR.
