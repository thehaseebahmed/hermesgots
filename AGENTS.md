# AGENTS.md

Guidance for AI coding agents (and humans) working on Memento: a playful, minimal PWA companion for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

## Repository

- `app/` is the web and Android app. Run every command below from `app/`; paths in the rest of this file are relative to it unless they start with `plugin/`.
- `plugin/` is the Memento Hermes plugin (Python, no build step). See **Plugin** below.
- `netlify.toml` stays at the root and sets `base = "app"`.

## Commands

```bash
cd app
pnpm install
pnpm dev         # Vite dev server
pnpm dev:netlify # Netlify CLI dev server (Identity + the sync function; needs a linked site)
pnpm mock        # fake Hermes API on :8642 (say "clean up" to trigger an approval)
pnpm lint        # oxlint
pnpm typecheck   # tsc -b
pnpm build       # typecheck + production build (also generates the service worker)
pnpm build:android # native-mode build (no service worker) synced into android/; set VITE_SITE_URL for sync
pnpm format      # prettier (with the Tailwind class sorter) over src/
```

Before you commit, run `pnpm lint`, `pnpm typecheck` and `pnpm build`. All three must pass.

## Git commits

**Always use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).** The format is:

```
<type>(<optional scope>): <imperative summary, lower case, no trailing period>

<optional body: what changed and why>
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Scopes, when they help: `chat`, `settings`, `bots`, `hermes`, `db`, `pwa`, `ui`, `deps`.
- Breaking changes: put `!` after the type or scope (e.g. `feat(db)!: ...`) and add a `BREAKING CHANGE:` footer.
- Keep the summary line to 72 characters or fewer.
- Use one logical change per commit.
- Examples:
  - `feat(chat): show approvals in place of the composer`
  - `fix(hermes): handle CRLF line endings in SSE frames`
  - `docs: document the HTTPS requirement for remote Hermes servers`

PR titles follow the same format. Fill in `.github/pull_request_template.md` for every PR.

## Stack

- Vite, React 19, TypeScript and Tailwind v4.
- React Router (`src/App.tsx`).
- **shadcn/ui on Base UI**, `base-maia` style (`components.json`). Components live in `src/components/ui/`.
  - Base UI uses the `render` prop, not Radix's `asChild`.
  - Use shadcn components wherever one fits before writing your own.
  - Add new ones with `pnpm dlx shadcn@latest add <name>`. Leave the generated files alone unless there's a reason to change them.
- Dexie (IndexedDB) for all app data. `vite-plugin-pwa` handles the manifest and service worker. Deployed on Netlify (`netlify.toml`).
- Capacitor 8 wraps the same build as an Android app (`capacitor.config.ts`, `android/`). `.github/workflows/android.yml` builds the APK on pushes to `main` and to PRs into `main`.

## Layout

| Path | What lives there |
| --- | --- |
| `src/lib/hermes.ts` | Hermes API client and SSE parser |
| `src/lib/chat.ts` | Send/stop a turn, stream it into IndexedDB and resume it after a drop; approval answers |
| `src/lib/db.ts` | Dexie schema, types, settings and profile (bot) helpers |
| `src/lib/cron.ts` | Fetches Hermes cron jobs and their runs (from the Memento plugin) |
| `src/lib/speech.ts` | Voice dictation hook (browser Web Speech API; Android's own recognizer in the app) |
| `src/lib/vault.ts` | Sync encryption: data key, passkey (PRF) and recovery-code wrapping, seal/unseal |
| `src/lib/account.ts` | Netlify Identity GitHub sign-in and the sync function's document API |
| `src/lib/sync.ts`, `merge.ts` | Sync state, unlock flows, and merging bots and chat lists with the server |
| `src/lib/history.ts` | Loads a synced chat's transcript from Hermes into IndexedDB |
| `netlify/functions/sync.mts`, `netlify/lib/docs.ts` | The opaque per-user document store (Netlify Blobs) |
| `src/lib/native.ts`, `native-account.ts` | Android app: platform checks, back button, and GoTrue sign-in and sync calls over native HTTP |
| `public/auth/native.html` | Sign-in bridge the app opens in a Custom Tab; hands the tokens back via `memento://auth` |
| `android/`, `capacitor.config.ts`, `assets/icon.png` | Capacitor Android project (icons and splash generated from `assets/icon.png` with `@capacitor/assets`) |
| `src/routes/` | `chat.tsx`, `settings.tsx`, `routines.tsx` (cron jobs), `bots.tsx` (gallery), `setup.tsx` (sign-in gate and first-run wizard) |
| `src/components/chat/` | Message rendering, tool and approval cards, composer, header |
| `src/components/bots.tsx` | Bot character definitions (SVG). `bot.tsx` renders them |
| `src/components/bot-card.tsx`, `bot-settings.tsx` | Bot cards (sidebar strip, settings) and the bot editor |
| `src/index.css` | Theme tokens (light and dark) and bot/typing animations |
| `scripts/mock-hermes.mjs` | Dev-only Hermes stand-in |

## Hermes API

These behaviours were verified against Hermes's `gateway/platforms/api_server*.py`. Check the source again before relying on anything new.

- Turns run on `POST /v1/runs` when `GET /v1/capabilities` reports `run_submission` and `run_events_sse`. A chat completion's agent is interrupted when its SSE client disconnects, which happens whenever a phone sleeps mid-reply. A run keeps going without a client.
  - `GET /v1/runs/{id}/events?last_seq=N` replays the buffered events after `N` and then follows live ones. CORS doesn't allow `Last-Event-ID`, so the cursor goes in the query. Each event carries `seq`, which the reply stores (`runSeq`, along with `runId`) so it can resume after a dropped stream or a reload.
  - Hermes keeps the buffer (1000 events) for 5 minutes while nobody is listening. After that the events endpoint returns 404, and `GET /v1/runs/{id}` (whose `output` and `usage` are kept for 24h when the run was started with an `Idempotency-Key`) is polled instead.
  - Events: `message.delta`, `message.interim`, `tool.started` / `tool.completed` (no call id, so a completion matches the oldest running call of that tool), `reasoning.available` (a whole block, non-streaming providers only), `approval.request`, `replay.truncated` and the terminal `run.completed | failed | cancelled | interrupted`, which carries `output` and `usage` (`input_tokens`, `output_tokens`).
  - A keyed profile sends `session_id` in the body and only the new message as `input`. A keyless one sends the whole transcript.
  - `POST /v1/runs/{id}/stop` stops a run.
- Older servers fall back to `POST /v1/chat/completions` with `stream: true`, whose stream interleaves named SSE events with the normal chunks: `hermes.tool.progress`, `hermes.status` and `approval.request`.
- Approvals are answered with `POST /v1/runs/{completion_id}/approval` and a body of `{ choice }`.
- `X-Hermes-Session-Id` continues a session. Hermes only accepts it when `API_SERVER_KEY` is set.
- Hermes's CORS setup does not expose response headers, which is why the client mints its own session ids.
- `GET /v1/skills` lists skills for the `/` menu. The code returns `{ object: "list", data }` (the docs show a bare array), and on some versions it returns a 500, so the menu must work without it.
- The API server does **not** expand `/skill-name` messages (only the CLI and messaging gateway do). The composer sends them literally and the model decides what to do with them.
- **Profiles are bots.** Hermes has no endpoint that lists profiles, so the user adds each one in Settings (a `profiles` row with its own URL, key and model). With `gateway.multiplex_profiles`, secondary profiles are served at `/p/<profile>/...`. Each profile has its own `API_SERVER_KEY`, and a named profile advertises its name as the `/v1/models` id. The mock serves the same `/p/<profile>/` prefix.
- The final stream chunk carries `usage`. Hermes sums it over **every** model call in the turn, so on a turn that ran tools `prompt_tokens` counts the prompt more than once. No endpoint reports the model's context window, so each bot stores its own.
- Hermes auto-titles API sessions (an instant slice of the opener, then a background model call that can land after the stream ends, and again on turns 2–3 for a placeholder like "Friendly greeting"). `GET /api/sessions/{id}` (server root) returns `{ session: { title } }` but not where the title came from. Memento polls it after the first three turns, which needs the session id and so an API key. CORS doesn't allow `PATCH`, so renames stay local (`titleEdited`) and Hermes's title never replaces them.
- `GET /api/model/options` (server root, not `/v1`) returns the configured `model` and `provider` behind a profile. Older versions don't have it, so treat a failure as unknown.
- The context window is looked up in [models.dev](https://models.dev/api.json) (`limit.context`) by that `provider`/`model` (`src/lib/models.ts`). The bot remembers which model it was for and resets it when the model changes; if models.dev doesn't list the model, the user sets it by hand.
- Cron jobs are called **Routines** in the UI (`/routines`) and `cron` in code. `GET /api/jobs?include_disabled=true` (server root) returns `{ jobs }`. Each job carries `last_run_at`, `last_status` and `failure_streak`. `POST /api/jobs/{id}/pause | resume | run` control a job. A 501 means cron isn't available.
- The API server has **no run-history endpoint** (the dashboard's `/api/cron/jobs/{id}/runs` is localhost-only), so **run history needs the Memento plugin** (`plugin/`). `GET /api/plugins/memento/cron/runs?per_job=24` returns `{ jobs: { <jobId>: [run, ...] } }`, newest first, straight from Hermes's execution ledger (`status` `claimed | running | completed | failed | unknown`, plus `delivery_outcome`; a `completed` run whose delivery `failed` counts as failed). Without the plugin the route doesn't exist, and Hermes's 404 for an unknown route skips its CORS middleware, so the browser blocks it and `fetch` fails with no status. `syncCron` treats a failed plugin call as a missing plugin when `/api/jobs` on the same server succeeded, and the Routines screen shows the install commands instead. Runs aren't stored on the device.
- **Voice input uses the browser's Web Speech API (and, in the Android app, whose WebView has no recognizer, Android's `SpeechRecognizer` through `@capgo/capacitor-speech-recognition`), not Hermes STT.** Hermes exposes its STT provider config only on the dashboard server (`GET /api/audio/voice-config`), whose CORS allows only `localhost` origins and whose session token rotates each start; the API server reports `audio_api: false`. The wire shapes it hands out (OpenAI multipart, xAI, ElevenLabs) are upload-only, not streaming.
- `GET /api/sessions/{id}/messages?order=latest&limit&offset` (server root) pages a session's transcript back from the newest row, but returns each page oldest first. Rows carry `id` (increasing), `role`, `content`, `tool_calls`, `tool_call_id`, `tool_name`, `timestamp` (Unix seconds), `reasoning` and `display_kind` (`hidden` rows are compaction scaffolding; skip them). Memento uses it to fill in chats synced from another device.
- If you change how the API is used, update `scripts/mock-hermes.mjs` to match.

## Plugin

- `plugin/` installs with `hermes plugins install thehaseebahmed/memento/plugin --enable` (Hermes clones the subdirectory into `~/.hermes/plugins/memento`). `plugin.yaml` holds the version; `dashboard/manifest.json` repeats it, so bump both.
- **The app can't reach dashboard plugin routes.** The dashboard (`hermes dashboard`, :9119) only allows `localhost` origins, and its session token changes on every start. So the routes the app needs go on the API server: `register(ctx)` calls `ctx.register_platform_handler("api_server", factory)`, and Hermes hands the factory the API server's aiohttp app before its router freezes. Those routes get the API server's CORS handling, and they check the key with the adapter's `_check_auth`.
- Routes live under `/api/plugins/memento/`: `info` and `cron/runs?per_job=N[&job_id=]`. The latter reads `cron.executions.list_executions`, the ledger behind the API server's `latest_execution`. `POST sessions/{id}/label` sets a session's `source` to `memento`, which the Hermes dashboard shows as its label.
- **Chats carry a `memento` label in the Hermes dashboard.** The dashboard shows a session's `source`. `POST /api/sessions` only accepts a fixed list of sources (anything else becomes `api_server`), so the plugin relabels the row after Memento's first turns (`api_server` or `unknown` rows only, never another surface's). Hermes's session upsert never overwrites a set source, and a compression child inherits its parent's, so the label sticks. Keyless bots can't be labelled: Memento doesn't know their session ids. Unlike `api_server`, a `memento` source isn't in Hermes's stale-open auto-close list, so its sessions are never closed and pruned for inactivity.
- `dashboard/` is a status tab. `dist/index.js` is hand-written against `window.__HERMES_PLUGIN_SDK__` (no React import, no bundler), and `plugin_api.py` serves `/api/plugins/memento/status` on the dashboard.
- Python changes need `hermes gateway restart` (API routes) and a dashboard restart (the tab's backend).
- If you change the plugin's routes, update `app/scripts/mock-hermes.mjs` to match.

## Sync

- Sign-in is Netlify Identity with the GitHub provider (`@netlify/identity`). It only identifies the owner. **Never send plaintext, a key or anything that derives one to the server.** Every document the function stores is sealed with `vault.ts` first, and the associated data names its owner and slot (`memento:<userId>:<doc>`).
- **In the Android app** the page is `https://localhost`, and `@netlify/identity` only talks to its own origin. So `account.ts` hands off to `native-account.ts`, which calls `${VITE_SITE_URL}/.netlify/identity` and the sync function through `CapacitorHttp.request` with a Bearer token. Don't turn on `CapacitorHttp`'s fetch patching: it would buffer Hermes's SSE streams. GoTrue ignores `redirect_to` and returns to the page that started sign-in (its `Referer`, when on the site's host), so sign-in starts from `/auth/native.html`. The function skips its origin check for Bearer requests. Passkeys are off in the app, so it unlocks with the recovery code.
- **Sign-in is compulsory where Identity is available.** `SetupGate` (`src/routes/setup.tsx`) keeps the app behind GitHub sign-in and unlocked sync unless the account is `unavailable` (plain `pnpm dev`, no Identity, no `VITE_SITE_URL`, or offline), and behind the first-run wizard until `Settings.onboarded`. An upgrade with configured bots is marked onboarded without the Hermes steps.
- Documents are `vault` (the wrapped data keys), `bots` and `chats/<botId>`. Writes carry the etag they read; a 412 means re-pull, merge and retry.
- Records merge last-write-wins on a change clock: `Profile.updatedAt` and `Conversation.changedAt`. Change synced fields through `updateProfile` / `updateConversation` so the clock moves, and delete through `deleteProfile` / `deleteConversation` so a tombstone is left for sync.
- Message bodies don't sync. They come from Hermes (`history.ts`): with `X-Hermes-Session-Id`, Hermes builds the turn's history from its own session store and ignores the body's, so its transcript holds every device's turns. An open chat catches up (`reconcileHistory`) on open, when its `updatedAt` changes, on focus, every 30s while visible, and before a send. `Conversation.hermesTip` (local only) lets that start with a one-row probe. Turns streamed on this device are kept (they carry stats and approvals) and matched to their rows by `hermesRowId`.
- A chat's context use (`contextTokens`) syncs with the chat list, since Hermes has nothing to recompute it from: the session's `input_tokens` is summed over every call, and message rows' `token_count` is unset.

## Conventions

- **The UI renders from Dexie live queries.** Streaming writes into IndexedDB (throttled), and components never hold stream state.
- **If you change the schema, bump the Dexie version** in `src/lib/db.ts` and keep existing data loading.
- **Every screen must work at phone (390px) and tablet (≥768px) widths, in light and dark mode.**
  - Use the theme tokens. Don't hard-code colours, except for the fixed character palettes in the bots.
  - Respect safe-area insets.
  - Keep touch targets at 44px or larger.
- **Bots:** they are still by default. Only the header (and the empty-state hero) passes `animate`. Animations must respect `prefers-reduced-motion`.
- **Assets must be original or properly licensed.** Never copy third-party characters, mascots or brand assets, even as "inspiration" copies.
- **Never commit secrets.** API keys live only in the user's browser.
- **No explanatory copy.** Don't add UI text that explains how the app works or where its data comes from (footnotes, "from X" captions) unless asked. If it seems needed, ask first.
- Match the surrounding code: Prettier style (no semicolons, 100 columns) and few comments. Comments explain *why*.
