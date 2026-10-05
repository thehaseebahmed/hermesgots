# Memento plugin for Hermes

The [Memento](../README.md) app uses this plugin to keep each bot's chat list on its Hermes server, to show how full each chat's context is, to show routine (cron) history, to list Hermes Projects and create them with their GitHub repos cloned in, and to label its chats in the Hermes dashboard. It reads Hermes's cron execution ledger (`cron/executions.db`), so every device sees the same runs, including the ones that happened while no device was looking.

It has two parts:

- **API server routes** (`__init__.py`). Memento calls these with the bot's API key, and they follow the API server's `API_SERVER_CORS_ORIGINS`.
  - `GET /api/plugins/memento/info` returns the plugin's name, version and features.
  - `GET /api/plugins/memento/cron/runs?per_job=24[&job_id=…]` returns each job's newest runs from the ledger, newest first.
  - `GET /api/plugins/memento/chats` returns the chat list Memento keeps here: titles, Hermes session ids and deletions, keyed by chat id. `POST` it `{ "chats": { … } }` to merge a device's list in (the newer record wins) and get the merged list back. It's stored in `$HERMES_HOME/memento/memento.db`, outside the plugin's folder, so updates leave it alone.
  - `GET /api/plugins/memento/sessions/{id}/context` returns the prompt tokens of the session's latest model call and the context window Hermes runs it with, recorded by a `post_api_request` hook. It follows compression to the session that continues the chat.
  - `GET /api/plugins/memento/projects` returns the profile's Hermes Projects (`hermes project create`) with their folders, whether each folder is a git repo, and when a session last ran in one of them. Memento's Code screen lists them.
  - `GET /api/plugins/memento/github` says whether the server has a GitHub account (`GITHUB_TOKEN` or `GH_TOKEN` in the environment or `$HERMES_HOME/.env`, else the gh CLI's login), and `GET /api/plugins/memento/github/repos` lists its repos. The token stays on the server.
  - `POST /api/plugins/memento/projects` with `{ "name": …, "description": …, "repos": ["owner/name", …] }` creates a project in `$HERMES_HOME/projects/<slug>/` and clones each repo from GitHub into it, so a repo used by two projects has a clone in each. It needs `git` on the server.
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
