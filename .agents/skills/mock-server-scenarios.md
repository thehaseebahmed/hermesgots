---
name: mock-server-scenarios
description: Use when testing the Gots mock Hermes server (pnpm mock).
category: devops
---

# Mock Hermes Server Scenarios

The mock server (`pnpm mock` from `app/`) is a dev-only stand-in for the Hermes Agent API server on port 8642. It speaks the same wire format as `gateway/platforms/api_server*.py` and is used by the Gots app during development.

```bash
cd app
pnpm mock            # starts on http://localhost:8642/v1
```

Point Gots Settings at `http://localhost:8642/v1` to use it.

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8642` | Port to listen on |
| `MOCK_NO_GITHUB` | unset | Set to `1` to simulate no GitHub account on host (signed out) |
| `MOCK_NO_PLUGIN` | unset | Set to `1` to disable Gots plugin endpoints (`/api/plugins/memento/*`) |
| `MOCK_NO_RUNS` | unset | Set to `1` to disable `/v1/runs` endpoints (like older Hermes) |
| `MOCK_RUN_BACKLOG` | `1000` | Event buffer size per run; shrink to exercise `replay.truncated` |
| `MOCK_DROP_EVENTS_MS` | `0` | Cut every event stream after N ms (simulates phone screen off) |
| `MOCK_BLOCK_RUN_EVENTS` | unset | Set to `1` to mimic Hermes v2026.9.24: no CORS on event stream, events dropped when blocked subscriber leaves |

### Common Combinations

```bash
# No plugin (tests fallback to Netlify chats)
MOCK_NO_PLUGIN=1 pnpm mock

# No GitHub (tests public repo cloning only)
MOCK_NO_GITHUB=1 pnpm mock

# Old Hermes without runs
MOCK_NO_RUNS=1 pnpm mock

# Stress test event replay truncation
MOCK_RUN_BACKLOG=10 pnpm mock

# Simulate dropped connection after 5s
MOCK_DROP_EVENTS_MS=5000 pnpm mock

# Legacy Hermes event stream behavior
MOCK_BLOCK_RUN_EVENTS=1 pnpm mock

# All limits combined
MOCK_NO_GITHUB=1 MOCK_NO_PLUGIN=1 MOCK_RUN_BACKLOG=5 MOCK_DROP_EVENTS_MS=3000 pnpm mock
```

---

## Message Triggers

Send these phrases in a chat message to trigger specific mock behaviors:

| Trigger | Behavior |
|---------|----------|
| `plan` | Enters plan mode: agent reads, asks clarify questions, writes structured plan, leaves it pending |
| `clean` / `delete` | Triggers approval request for `find /var/log -name '*.log.*' -mtime +90 -delete` |
| `long` / `slow` | 20-step slow reply (1s per step) — tests stream resume after disconnect |
| `fail` | Tool call fails with "Permission denied" |
| `ask` | Single clarify question: "Which logs should I count as old?" |
| `ask five` | Five clarify questions (env, services, name, data handling, reviewers) |
| `commit` (in project session) | Prevents workspace removal on `workspace/remove` (simulates unpushed work) |
| `merge` / `close` / `draft` (in project session) | Sets PR state to merged/closed/draft |
| `break` (in project session) | Fails PR checks |
| `pending` (in project session) | Sets PR checks to pending |

### Plan Mode Details

When `plan` is in the message:
1. Agent runs read-only tools (`terminal` git log, `read_file`)
2. Asks 2 clarify questions (dry-run output format, files to keep)
3. Writes a full plan to `plans/<branch-slug>-<timestamp>.md`
4. Sets `workspace.plan_pending = 1` and `workspace.plan_file`
5. Stops — user must approve before acting

---

## Profile Multiplexing

The mock supports Hermes's `gateway.multiplex_profiles` via `/p/<profile>/` prefix:

```
http://localhost:8642/v1              # default profile
http://localhost:8642/p/alice/v1      # profile "alice"
http://localhost:8642/p/bob/v1        # profile "bob"
```

### Profile-Specific Behavior

- **`/v1/models`**: Returns profile name as model id (`mock-model-alice`, `mock-model-bob`, or `hermes-agent` for default)
- **`/api/model/options`**: Named profiles report `mock-model-<profile>` with provider `openrouter` (exercises manual model entry in app)
- **Cron jobs** (`/api/jobs`): Seeded per-profile with deterministic but different run histories
- **Plugin endpoints** (`/api/plugins/memento/*`): **Only served on default profile** (no `/p/<profile>/` prefix), matching real Hermes

### Testing Multiple Profiles

```bash
# Terminal 1: default profile
pnpm mock

# Terminal 2: not needed — same server handles all /p/<profile>/ routes
# Just configure Gots with two bots:
# Bot 1: http://localhost:8642/v1
# Bot 2: http://localhost:8642/p/alice/v1
```

---

## Endpoint Reference

### Core Hermes Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{ status: "ok", platform: "mock-hermes" }` |
| GET | `/v1/models` | Lists models (profile-aware) |
| GET | `/api/model/options` | Model + provider for current profile |
| GET | `/v1/capabilities` | Feature flags (runs depend on `MOCK_NO_RUNS`) |

### Chat Completions (Legacy)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Streaming SSE with `hermes.tool.progress`, `hermes.status`, `approval.request` events |

### Runs (Modern)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/runs` | Start a run (returns `run_id`, `status: "started"`) |
| GET | `/v1/runs/{id}` | Run status, output, usage, approval/clarify if waiting |
| GET | `/v1/runs/{id}/events?last_seq=N` | SSE event stream with `seq` numbers, replay support |
| POST | `/v1/runs/{id}/stop` | Stop a running run |
| POST | `/v1/runs/{id}/approval` | Answer approval: `{ choice: "once" \| "session" \| "always" \| "deny" }` |

### Cron / Routines

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobs?include_disabled=true` | 3 jobs per profile (Inbox triage 60m, Uptime 15m, Morning digest daily+paused) |
| POST | `/api/jobs/{id}/pause\|resume\|run` | Control a job |

### Gots Plugin Endpoints (default profile only, requires `MOCK_NO_PLUGIN` unset)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins/memento/info` | Plugin manifest with features list |
| GET | `/api/plugins/memento/skills` | The profile's skills for the composer's `/` menu (3 fixtures) |
| GET | `/api/plugins/memento/cron/runs?per_job=24` | Ledger-style run history per job |
| GET | `/api/plugins/memento/github` | `{ connected: true, login: "mock-user" }` or `connected: false` |
| GET | `/api/plugins/memento/github/repos` | 5 mock repos (memento, maze, dotfiles, zigbee-bridge, ha-automations) |
| POST | `/api/plugins/memento/projects` | Create project with repos (simulates clone delay) |
| POST | `/api/plugins/memento/projects/{id}` | Rename/describe project |
| POST | `/api/plugins/memento/projects/{id}/remove` | Delete project |
| GET | `/api/plugins/memento/projects` | List all projects with activity |
| GET/POST | `/api/plugins/memento/chats` | Chat list sync (newer record wins) |
| POST | `/api/plugins/memento/sessions/{id}/label` | Mark session as Gots-owned |
| GET | `/api/plugins/memento/sessions/{id}/context` | Latest model call prompt/output tokens |
| GET | `/api/plugins/memento/sessions/{id}/todos` | Todo list from transcript |
| POST | `/api/plugins/memento/runs/{id}/clarify` | Answer clarify questions |
| GET | `/api/plugins/memento/runs/live` | Sessions with active runs |
| POST/GET | `/api/plugins/memento/sessions/{id}/workspace` | Create/read project workspace (worktrees) |
| POST | `/api/plugins/memento/sessions/{id}/mode` | Change permission mode (accept_edits/auto/plan) |
| GET | `/api/plugins/memento/sessions/{id}/goal` | The session's goal as Hermes holds it: `{ text, status, turns_used, max_turns, contract, gates, subgoals, verdict, reason, paused_reason, waiting }`, null when it has none |
| POST | `/api/plugins/memento/sessions/{id}/goal` | Set one: `{ command, gates, max_turns }` (the `/goal` text the wizard composed); answers the goal and the `kick` to send |
| POST | `/api/plugins/memento/sessions/{id}/goal/control` | `{ action: "pause" \| "resume" \| "clear" }`; resume answers the `kick` to send |
| POST | `/api/plugins/memento/sessions/{id}/workspace/remove` | Remove worktrees (keeps if "commit" said) |
| GET | `/api/plugins/memento/sessions/{id}/prs` | PRs per repo after 2 turns |

### Session Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/{id}` | Session title + source (memento/api_server) |
| GET | `/api/sessions/{id}/messages?order=latest&limit&offset` | Paged transcript (newest first, each page oldest first) |

---

## Common Test Recipes

### 1. Test Approval Flow (Auto vs Accept Edits)

```bash
# Default: accept_edits mode — asks for approval
pnpm mock
# In chat: "clean up the logs" → approval card appears

# Auto mode: plugin bypasses approval
# In project session, switch mode to "auto" via UI or:
# POST /api/plugins/memento/sessions/{id}/mode { "mode": "auto" }
# Then "clean up" → runs without asking
```

### 2. Test Plan Mode

```bash
pnpm mock
# In chat: "plan to add a dry-run flag"
# → reads files, asks 2 questions, writes plan, stops
```

### 3. Test Stream Resume (Phone Sleep)

```bash
MOCK_DROP_EVENTS_MS=5000 pnpm mock
# Start a long turn ("tell me a long story" or "long")
# Wait 6s → stream cuts
# App should resume via GET /v1/runs/{id} polling
```

### 4. Test Replay Truncation

```bash
MOCK_RUN_BACKLOG=10 pnpm mock
# Run a turn with many events
# Reconnect with last_seq=0 → gets replay.truncated
```

### 5. Test Legacy Hermes (No Runs)

```bash
MOCK_NO_RUNS=1 pnpm mock
# Only /v1/chat/completions works
# No /v1/runs, no event streaming
```

### 6. Test No Plugin Fallback

```bash
MOCK_NO_PLUGIN=1 pnpm mock
# /api/plugins/memento/* returns 404 (no CORS)
# App should fall back to Netlify chats document
# Routines screen shows install commands
```

### 7. Test No GitHub Account

```bash
MOCK_NO_GITHUB=1 pnpm mock
# /api/plugins/memento/github → { connected: false }
# /api/plugins/memento/github/repos → 409 error
# Project creation still works for public repos
```

### 8. Test Multi-Profile Bots

```bash
pnpm mock
# Bot 1 (default): http://localhost:8642/v1
# Bot 2 (alice): http://localhost:8642/p/alice/v1
# Each has separate model id, cron history, session space
# Plugin endpoints only on default
```

### 9. Test Project Session Workflow

```bash
pnpm mock
# 1. Create project via POST /api/plugins/memento/projects
#    { "name": "Test", "repos": ["mock-user/memento"] }
# 2. Start chat with project session
# 3. POST /api/plugins/memento/sessions/{id}/workspace { "project_id": "..." }
#    → returns worktree info + instructions for agent
# 4. Send "plan" → plan mode with workspace context
# 5. After 2 turns → GET /api/plugins/memento/sessions/{id}/prs shows PRs
# 6. Say "merge" → PRs become merged
```

### 10. Test Clarify Questions

```bash
pnpm mock
# "ask" → single question, waits for POST /api/plugins/memento/runs/{id}/clarify
# "ask five" → 5 questions (multi-select on some)
# Plan mode always asks before writing plan
```

### 11. Test Todo List Persistence

```bash
pnpm mock
# "plan" → creates todo list via todo_list tool
# GET /api/plugins/memento/sessions/{id}/todos → returns list with revision
# Next turn → revision increments, list updates
```

### 12. Test Context Reporting

```bash
pnpm mock
# Run a few turns
# GET /api/plugins/memento/sessions/{id}/context
# → { prompt_tokens, output_tokens, context_length, model, provider, at }
```

---

## Debugging Tips

- **Logs**: All requests log to console with method, path, profile
- **Transcripts**: Stored in memory per session (`X-Hermes-Session-Id` or `session_id`)
- **Run events**: Inspect `runs` Map in debugger — each has `events[]` with `seq`
- **CORS**: Plugin endpoints omit CORS on 404 (mimics real Hermes) — browser blocks fetch
- **Sessions**: Keyed sessions require `Authorization` header + `X-Hermes-Session-Id`

---

## Files

- **Source**: `app/scripts/mock-hermes.mjs` — update when adding routes to real API
- **Package script**: `app/package.json` → `"mock": "node scripts/mock-hermes.mjs"`
- **Docs**: `AGENTS.md` (lines 27, 65, 100, 120, 137, 154)