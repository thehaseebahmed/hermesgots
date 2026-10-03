# Memento plugin for Hermes

The [Memento](../README.md) app needs this plugin to show routine (cron) history. It reads Hermes's cron execution ledger (`cron/executions.db`), so every device sees the same runs, including the ones that happened while no device was looking.

It has two parts:

- **API server routes** (`__init__.py`). Memento calls these with the bot's API key, and they follow the API server's `API_SERVER_CORS_ORIGINS`.
  - `GET /api/plugins/memento/info` returns the plugin's name, version and features.
  - `GET /api/plugins/memento/cron/runs?per_job=24[&job_id=…]` returns each job's newest runs from the ledger, newest first.
- **A dashboard tab** (`dashboard/`). **Memento** in `hermes dashboard` shows the plugin's version, whether it's enabled, and how many runs the ledger holds.

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

- Routes are served on the API server's own listener, not under `/p/<profile>/` on a multiplexed gateway. Give each profile its own API server port to use routines with Memento.
- The ledger keeps the newest 1,000 finished runs across all jobs.
