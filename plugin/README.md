# Memento plugin for Hermes

The [Memento](../README.md) app uses this plugin to keep each bot's chat list on its Hermes server, to show how full each chat's context is, to show the agent's todo list in each chat, to show routine (cron) history, to list Hermes Projects and create them with their GitHub repos cloned in, to run project sessions in their own git worktrees with a permission mode, and to label its chats in the Hermes dashboard. It reads Hermes's cron execution ledger (`cron/executions.db`), so every device sees the same runs, including the ones that happened while no device was looking.

It has two parts:

- **API server routes** (`__init__.py`). Memento calls these with the bot's API key, and they follow the API server's `API_SERVER_CORS_ORIGINS`.
  - `GET /api/plugins/memento/info` returns the plugin's name, version and features.
  - `GET /api/plugins/memento/cron/runs?per_job=24[&job_id=…]` returns each job's newest runs from the ledger, newest first.
  - `GET /api/plugins/memento/chats` returns the chat list Memento keeps here: titles, Hermes session ids and deletions, keyed by chat id. `POST` it `{ "chats": { … } }` to merge a device's list in (the newer record wins) and get the merged list back. It's stored in `$HERMES_HOME/memento/memento.db`, outside the plugin's folder, so updates leave it alone.
  - `GET /api/plugins/memento/sessions/{id}/context` returns the prompt tokens of the session's latest model call and the context window Hermes runs it with, recorded by a `post_api_request` hook. It follows compression to the session that continues the chat.
  - `GET /api/plugins/memento/sessions/{id}/todos` returns `{ revision, todos }`: the list the agent's `todo_list` tool last wrote in the session (or the sessions it was compressed from), read from the transcript. Both are null when it has none.
  - `GET /api/plugins/memento/projects` returns the profile's Hermes Projects (`hermes project create`) with their folders, whether each folder is a git repo and its GitHub `user/repo`, and when a session last ran in one of them. Memento's Code screen lists them.
  - `GET /api/plugins/memento/github` says whether the server has a GitHub account (`GITHUB_TOKEN` or `GH_TOKEN` in the environment or `$HERMES_HOME/.env`, else the gh CLI's login), and `GET /api/plugins/memento/github/repos` lists its repos. The token stays on the server.
  - `POST /api/plugins/memento/projects` with `{ "name": …, "description": …, "repos": ["owner/name", …] }` creates a project in `$HERMES_HOME/projects/<slug>/` and clones each repo from GitHub into it, so a repo used by two projects has a clone in each. It needs `git` on the server.
  - `POST /api/plugins/memento/sessions/{id}/workspace` with `{ "project_id": …, "task": …, "mode": … }` gives a Memento project session a git worktree in every repo of the project (`<repo>/.worktrees/<task-slug>`, branch `hermes/<task-slug>`, made with Hermes's own worktree code) and points the session's terminal and file tools into the primary repo's. The answer carries the workspace (each repo as `user/repo` from its GitHub `origin`) and an `instructions` line that tells the agent where its worktrees are, which Memento adds to every run. Memento posts it before every run, because that pointer only lives in the gateway's memory; the `pre_tool_call` hook restores it after a restart. `GET` returns the workspace (null without one), `POST …/mode` with `{ "mode": "accept_edits" | "auto" | "plan" }` changes the permission mode, and `POST …/workspace/remove` removes each worktree that has no uncommitted changes and no commits a remote lacks, keeps the others and says which (`kept: [{ name, reason }]`).
  - In `auto` mode the same hook turns on Hermes's per-run approval bypass (`enable_session_yolo`, keyed by the run id), so dangerous commands run without a prompt and nothing needs the app open; the hardline blocklist still blocks. It switches the bypass off again when the mode isn't `auto`. `POST …/mode` to `auto` also approves, once, anything a run of the session is already waiting on (a guardian's DENY is left for the user).
  - In `plan` mode the plugin's `pre_tool_call` hook blocks `write_file`, `patch`, `execute_code`, `delegate_task` and any `terminal` command that isn't a plain read (`ls`, `cat`, `grep`, read-only `git`, …), so the agent can only investigate and present a plan, and the run's `instructions` carry the plan's shape (overview, approach, changes, checkpoints that each name their commit message, verification, risks and assumptions) and ask the agent to settle every open choice first, with the `clarify` tool where it can, so the plan leaves nothing for the user to decide. A reply that is a plan (it has a `# Plan:` heading) is saved by the `post_llm_call` hook as `plans/<branch slug>-<YYYYMMDD-HHMMSS>.md` under the project's primary folder, with a YAML front matter naming the session, branch, project and time; every iteration gets its own file, and when that folder is itself a git repo `plans/` goes into its `.git/info/exclude`. The workspace reports the newest one as `plan_file`. When such a turn finishes, the workspace also reports `plan_pending`, which Memento shows as a plan waiting for approval, until the user changes the mode or sends the next message.
  - `GET /api/plugins/memento/sessions/{id}/prs` returns the newest pull request from the session's branch in each of its repos (`{ repo, number, title, state, checks, url }`, where `state` is `open`, `draft`, `merged` or `closed` and `checks` is `success`, `failure`, `pending` or null from the head commit's check runs and statuses). Looked up with the server's GitHub token when it has one.
  - `GET /api/plugins/memento/runs/live` lists the sessions with a run in flight on this API server, each `running` or `waiting_for_approval`, with its run id in `run_ids`, so every device can tell which project sessions are working or waiting.
  - **The agent can ask the user questions.** Hermes's `clarify` tool isn't in the API server's toolset and its agents get no way to show a question, so the plugin adds the tool to every agent the API server builds and answers it from Memento: a call puts `clarify.request` on the run's event stream (`{ clarify_id, questions: [{ id, question, choices?, multi_select? }] }`, the first choice being the recommended one) and `clarify` on the run's status while the run waits as `waiting_for_approval`; Memento shows the questions in place of the composer and posts the answers to `POST /api/plugins/memento/runs/{run_id}/clarify` with `{ "clarify_id", "answers": { "q0": "a choice or typed text" | ["several"] | null }, "outcome": "submitted" | "cancelled" }`; the run then carries `clarify.responded` and the agent carries on in the same turn with the answers. An unanswered question times out after Hermes's `agent.clarify_timeout` (an hour by default). `GET /api/plugins/memento/info` reports `clarify: true` when the wiring took on this Hermes version.
  - `POST /api/plugins/memento/sessions/{id}/label` marks a Memento chat's session with the `memento` source, so the dashboard's Sessions page labels it **Memento**. It only relabels sessions the API server created.
- **A dashboard tab** (`dashboard/`). **Memento** in `hermes dashboard` shows the plugin's version, whether it's enabled, how many runs the ledger holds and how many chats it stores.

## Install

```bash
hermes plugins install thehaseebahmed/memento/plugin --enable
hermes gateway restart
```

Restart `hermes dashboard` too if it's running, so it picks up the new tab.

To update, run `hermes plugins update memento`, then restart the gateway.

## Requirements

- A Hermes version with the cron execution ledger and `ctx.register_platform_handler`.
- The API server enabled with an `API_SERVER_KEY`, the same setup Memento needs anyway.

## Limitations

- Routes are served on the API server's own listener, not under `/p/<profile>/` on a multiplexed gateway. Give each profile its own API server port to use routines, and keep its chats here, with Memento.
- The ledger keeps the newest 1,000 finished runs across all jobs.
