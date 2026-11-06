# Gots plugin: what it does that you would want to know before installing

The Hermes plugin catalog's rule 13 asks a plugin to disclose network calls to third-party services,
reads outside its own data, shell commands, long-running background work and stored credentials, and
to make telemetry opt-in. This is that list for `plugin/` at version 0.110.0, checked against the
code; each line names where it lives. The plugin keeps its own data in
`$HERMES_HOME/plugin-data/gots/` (`gots.db`, `link.json`, attachments, meetings, dictations).

## Network calls

| To | When | Where |
| --- | --- | --- |
| GitHub's REST API (`api.github.com`) | Listing your repositories, reading a project's issues (AFK's frontier), claiming and releasing a task (a label and an assignee), opening, updating and closing draft pull requests, deleting a pushed branch, reading check runs and pull-request state | `github.py`, `ship.py`, `tasks.py`, `afk.py`, `merges.py`, `closes.py` |
| GitHub over git (`github.com`) | Cloning a project's repositories, fetching, and pushing a session's branch (`pull_request`), with the host's token as an `http.extraheader`, never saved in `.git/config` | `github.py`, `ship.py`, `sessions.py` |
| The Gots registry (the `--site` you link with; `hermesgots.dev` for the hosted app) | Claiming a link code, publishing this profile's bot record — its name, URL, API key and plugin version, **sealed** to your account's inbox key so the registry can't read it — a check-in every 10 minutes, and unlinking | `link.py` |
| The registry's Firebase relay | Asking the registry to push an Android notification: a kind, a category, the session id and the chat's title (the title travels in the clear to the registry and Firebase; never what was asked) | `push.py` (`_relay`) |
| Web Push services (the endpoint each browser subscription names) | Notifications to an installed PWA, encrypted to the device (RFC 8291) and signed with the device's VAPID key (RFC 8292) | `push.py` |
| `ollama.com` | Reading an Ollama Cloud account's balance for the usage sheet, only for that provider and only with the profile's `OLLAMA_API_KEY` | `usage_ollama.py` |
| Any web page a research mission cites | `claim_add` fetches the page (20 s, 6 MB) to check that the quoted passage is on it | `research.py` |
| Your model provider, through Hermes's `ctx.llm` | Triage of a Main message, research briefs/outlines/writing, meeting notes and answers, dictation cleanup — on the profile's own model unless you pick another (which needs Hermes's model-override grant) | `triage.py`, `research.py`, `meetings.py`, `dictation_cleanup.py` |
| Sentry (`GOTS_SENTRY_DSN`) | Crash reports from the plugin, **only** when the host sets that variable; off otherwise | `reporting.py` |
| The community leaderboard (the registry's `community` function) | Daily token counts by model, mode and provider, **only after you join** in the app (off by default) | `community.py` |
| This host's own API server (loopback) | Starting the runs a queued message, an AFK stage, a subagent's wake or a research mission needs, with the profile's own key | `outbox.py`, `afk.py`, `delegation.py`, `research.py` |

## Background work

Started with the API server (`_wire_api_server` in `__init__.py`) and stopped with it:

- **Midnight cleanup** (`cleanup.py`, daily at the server's local midnight): deletes Gots chats that never
  got a message and are a day old — their project worktrees (kept when they hold uncommitted or unpushed
  work), their Hermes session rows (`SessionDB.delete_session`), their attachments folder — and leaves
  a tombstone in the chat list. A session you saved as a draft is spared.
- **AFK sweep** (`afk.py`, every 3 minutes and on wake): for projects you switched on, reads their ready
  GitHub issues, claims the oldest, works it in a session of its own and opens a draft pull request.
- **Alerts** (`alerts.py`, every 5 minutes): failing pull-request checks and failed routines, pushed once.
- **Merges** (`merges.py`, every 5 minutes): resolves a session whose pull request merged.
- **Outbox dispatcher** (`outbox.py`, every second): starts a queued message's run once its session is free.
- **Delegation watchers** (`delegation.py`): a 5-second sweep that wakes a bot when its subagent finishes,
  and a 1-second watch that stops a stopped turn's subagents.
- **Link check-in** (`link.py`, every 10 minutes) for a linked profile.
- **Routine delivery** (`platform_gots.py`, every 20 s while a message waits for its chat to be free).
- **Research and meetings** (`research.py`, `meetings.py`): resume a mission or transcription a restart
  interrupted; transcription runs on threads of its own.
- **Title watch** (`stream.py`) and **project clones / repo adds / session closes** on threads of their
  own (`clones.py`, `repos.py`, `closes.py`), resumed after a restart.

## Shell commands

- `git` — clone, fetch, `worktree add/remove/unlock`, `status`, `rev-list`, `add -A`, `commit`, `push`,
  in a project's folders and its session worktrees (`github.py`, `sessions.py`, `ship.py`, `projects.py`).
- `gh auth token` — only to find a GitHub token when the profile sets none (`github.py`).
- **`afk_gate`** runs the commands an AFK build names, in the session's worktree, each under a 10-minute
  timeout with its process group ended on timeout (`gate.py`).
- **Local MCP servers for an app's page** (`mcp_call.py`): a page's query or mutation starts the named
  stdio MCP server from the profile's own config and calls one tool, without Hermes's per-call prompt. It
  runs only tools the user agreed to for that app (`apps/{id}/consent`, ADR 0102), and remote servers are
  refused. Reviewers should weigh this against rule 12.

## Reads and writes outside the plugin's data

- **`state.db`** (Hermes's sessions): read for transcripts, usage, lineage and subagents (read-only
  connections); written to stamp a session's `cwd`/branch, to put rows an older plugin relabelled back on
  `api_server` (`sessions.heal_sources`), to delete a session (cleanup) and to remove a moved message's
  rows when a move is undone (`moves.py`).
- **`projects.db`**: projects created, edited, archived and removed, and repos added and removed, through
  `hermes_cli.projects_db`.
- **`config.yaml`**, through Hermes's own writers and only on a request from the app or the CLI: the
  main model and fallbacks, the delegation model, speech-to-text settings, skills on/off, MCP servers,
  `platforms.gots.enabled` and, on a yes at `hermes gots link`, `clarify` in
  `platform_toolsets.api_server`.
- **`.env`**, through `hermes_cli.config.save_env_value` only: the lines linking adds
  (`API_SERVER_KEY`, `API_SERVER_ENABLED`, `API_SERVER_CORS_ORIGINS`, after a yes) and the values you give
  an MCP server. Credentials are **read** only through `agent.secret_scope` / `agent.credential_pool`.
- **`cron/executions.db`** (routine run history, read-only), the profile's skills (read; removed on
  request), and files on disk under `$HERMES_HOME/projects/` (clones, worktrees, `plans/`, `files/`, and a
  line in each clone's `.git/info/exclude`).

## Stored credentials

- `link.json` (0600): the registry host token for a linked profile.
- `gots.db`'s `push_subscriptions`: each browser's push subscription and the **device's VAPID private
  key**, which the device hands the plugin so it can sign that device's pushes.
- Nothing else: the GitHub token, `OLLAMA_API_KEY` and `API_SERVER_KEY` stay where Hermes keeps them and
  are read through Hermes's helpers when needed.

## Telemetry

- Community usage reporting: opt-in in the app's setup (off by default) and in Settings > Community.
- Crash reporting: off unless the host sets `GOTS_SENTRY_DSN`.

## Approvals

No mode bypasses Hermes's approvals (ADR 0110): Auto is gone, and AFK sessions run in Accept edits, so a
dangerous command waits for the user. Questions (`clarify`) wait for the user up to Hermes's own
`agent.clarify_timeout` and end cleanly when nobody answers.
