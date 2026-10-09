# Memento plugin for Hermes

The [Memento](../README.md) app needs this plugin on every Hermes profile it uses. It runs on your Hermes host, so the work you start from your phone keeps going, and stays correct, while the app is closed.

What it adds to Hermes:

- **Chat lists** for each bot, kept on the host so every device sees the same chats.
- **Questions and todos**: the agent can ask you questions in the app, and always has its todo list.
- **Context use**, so the app can show how full each chat's context window is.
- **Routines history** from Hermes's cron ledger, including runs that happened while no device was looking.
- **Code**: Hermes Projects with their GitHub repos cloned in, sessions that each work in their own git worktree with a permission mode (Accept edits, Auto or Plan), an `open_pull_request` tool the agent uses to ship its work, and sessions that resolve themselves when their pull request merges.
- **Live updates and notifications**: a change stream for an open app, and a push to a closed one when a session needs you (never what it asks).
- **A Memento tab** in the Hermes dashboard, and the `hermes memento` command that links a profile to your account.

[API.md](API.md) lists every route and hook, for people working on Memento.

## Install

```bash
hermes plugins install thehaseebahmed/memento/plugin --enable
hermes gateway restart
```

Memento's **Link your bots** screen gives you the install command together with the link command, so you rarely need this on its own. Restart `hermes dashboard` too if it's running, so it picks up the Memento tab.

Hermes asks whether to let the plugin pick the model for its own model calls (`llm.model_override` and `llm.provider_override`). Only the experimental Theseus mode uses these, to have its reviews done by a different model than the one that wrote the code. Saying no is fine; `hermes plugins enable memento` asks again.

For another profile, add `-p <name>`: `hermes -p <name> plugins install thehaseebahmed/memento/plugin --enable`.

## Update

Stop the gateway first: newer Hermes versions refuse to update a plugin while the gateway runs.

```bash
hermes gateway stop
hermes plugins update memento
hermes gateway start
```

## Linking to Memento

`hermes memento link <code> --site <url>` (from Memento's link screen; `hermes -p <name> memento link …` for another profile) links the profile to a Memento account, so it shows up in the app by itself:

- It claims the code, checks the account's key against the code's fingerprint, and keeps a host token in `$HERMES_HOME/memento/link.json` (owner-only).
- It always asks for the URL the app reaches the profile at. The default is the URL saved before, else `<main profile's URL>/p/<name>` for another profile, else Hermes's dashboard public URL (`HERMES_DASHBOARD_PUBLIC_URL`, then `dashboard.public_url`; Hermes has none for the API server), else `http://<hostname>:<API_SERVER_PORT>`. `--url` sets it without asking.
- It offers to add what `.env` still lacks: `API_SERVER_KEY`, `API_SERVER_ENABLED=true` and the app's origins in `API_SERVER_CORS_ORIGINS` (never for a profile under `/p/<name>`, which rides the main gateway). `--yes` accepts the defaults.
- It seals the bot record (name, URL, API key) to the account's key before it leaves; the registry can't read it.

The gateway then checks in at start and every 10 minutes for each profile it serves, re-publishing the record when the URL or key changed, when the app lost it, or when the account's key changed. A host removed in the app stops (`Check-in: removed in Memento`). `hermes memento status` checks in once and says how it went; `hermes memento unlink` removes the profile from the account.

The Hermes dashboard's **Memento** tab does the same for the dashboard's profile: paste the code, the address you open Memento at and the API server URL, then add the `.env` lines it lists if any. It also shows the link and unlinks.

Memento needs this plugin on every profile it uses: chat lists, context use, todos, questions and Code all live here.

## Requirements

- Hermes Agent v2026.9.24 or newer.
- The API server enabled with an `API_SERVER_KEY`. `hermes memento link` offers to set both up.
- An HTTPS address the app can reach the API server at. See [Reaching Hermes over HTTPS](../docs/https.md).
- For Code: `git` on the host. For private repos and pull requests, a GitHub login on the host: `gh auth login`, or `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment or `~/.hermes/.env`.
- For the experimental Theseus mode only: Node 20 or newer on the host.

## What it does with your GitHub token

The token stays on the host and never reaches the app. The plugin uses it to list your repos, clone them into `~/.hermes/projects/<project>/`, push a session's branch and open its pull request (when the agent calls `open_pull_request`), read a pull request's state and checks, and close a session's pull request and delete its branch when you delete or discard the session in the app. It passes the token to git as a header for each command, so it isn't saved in any repo's `.git/config`.

## Troubleshooting

- **The app says it can't reach the plugin.** Check `hermes plugins list` shows memento enabled in that profile, then `hermes gateway restart`. With the API key, `curl -H "Authorization: Bearer <key>" https://<address>/api/plugins/memento/info` should answer with the plugin's version.
- **A profile under `/p/<name>` has no context use, todos or plan files.** The plugin must be installed and enabled in that profile too (see **Install**).
- **`hermes memento link` can't find the code.** Codes last 30 minutes. Copy a fresh command from the app.
- **The Memento tab is missing from the dashboard.** Restart `hermes dashboard`.

## Limitations

- On a multiplexed gateway, a profile's routes are at `/api/plugins/memento/p/<profile>/...`, not `/p/<profile>/api/plugins/...`: Hermes's own catch-all for `/p/<profile>/` is registered before plugin routes. Memento handles that itself. The routes answer with the profile's own `API_SERVER_KEY`, home and chat list, but the hooks (context use, todos, plan files, labels) run only in profiles that have the plugin installed and enabled too; `info` reports `hooks: false` otherwise.
- The daily cleanup only covers the profile home the plugin was loaded in.
- The ledger keeps the newest 1,000 finished runs across all jobs.
