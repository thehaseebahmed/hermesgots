# AGENTS.md

Guidance for AI coding agents (and humans) working on Memento: a playful, minimal PWA companion for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

## Commands

```bash
pnpm install
pnpm dev         # Vite dev server
pnpm mock        # fake Hermes API on :8642 (say "clean up" to trigger an approval)
pnpm lint        # oxlint
pnpm typecheck   # tsc -b
pnpm build       # typecheck + production build (also generates the service worker)
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

## Layout

| Path | What lives there |
| --- | --- |
| `src/lib/hermes.ts` | Hermes API client and SSE parser |
| `src/lib/chat.ts` | Send/stop a turn and stream it into IndexedDB; approval answers |
| `src/lib/db.ts` | Dexie schema, types, settings and profile (bot) helpers |
| `src/lib/cron.ts` | Syncs Hermes cron jobs and folds their runs into IndexedDB |
| `src/routes/` | `chat.tsx`, `settings.tsx`, `routines.tsx` (cron jobs), `bots.tsx` (gallery) |
| `src/components/chat/` | Message rendering, tool and approval cards, composer, header |
| `src/components/bots.tsx` | Bot character definitions (SVG). `bot.tsx` renders them |
| `src/components/bot-card.tsx`, `bot-settings.tsx` | Bot cards (sidebar strip, settings) and the bot editor |
| `src/index.css` | Theme tokens (light and dark) and bot/typing animations |
| `scripts/mock-hermes.mjs` | Dev-only Hermes stand-in |

## Hermes API

These behaviours were verified against Hermes's `gateway/platforms/api_server*.py`. Check the source again before relying on anything new.

- The client uses `POST /v1/chat/completions` with `stream: true`.
- The stream interleaves named SSE events with the normal chunks: `hermes.tool.progress`, `hermes.status` and `approval.request`.
- Approvals are answered with `POST /v1/runs/{completion_id}/approval` and a body of `{ choice }`.
- `X-Hermes-Session-Id` continues a session. Hermes only accepts it when `API_SERVER_KEY` is set.
- Hermes's CORS setup does not expose response headers, which is why the client mints its own session ids.
- `GET /v1/skills` lists skills for the `/` menu. The code returns `{ object: "list", data }` (the docs show a bare array), and on some versions it returns a 500, so the menu must work without it.
- The API server does **not** expand `/skill-name` messages (only the CLI and messaging gateway do). The composer sends them literally and the model decides what to do with them.
- **Profiles are bots.** Hermes has no endpoint that lists profiles, so the user adds each one in Settings (a `profiles` row with its own URL, key and model). With `gateway.multiplex_profiles`, secondary profiles are served at `/p/<profile>/...`. Each profile has its own `API_SERVER_KEY`, and a named profile advertises its name as the `/v1/models` id. The mock serves the same `/p/<profile>/` prefix.
- The final stream chunk carries `usage`. Hermes sums it over **every** model call in the turn, so on a turn that ran tools `prompt_tokens` counts the prompt more than once. No endpoint reports the model's context window, so each bot stores its own.
- `GET /api/model/options` (server root, not `/v1`) returns the configured `model` and `provider` behind a profile. Older versions don't have it, so treat a failure as unknown.
- The context window is looked up in [models.dev](https://models.dev/api.json) (`limit.context`) by that `provider`/`model` (`src/lib/models.ts`). The bot remembers which model it was for and resets it when the model changes; if models.dev doesn't list the model, the user sets it by hand.
- Cron jobs are called **Routines** in the UI (`/routines`) and `cron` in code. `GET /api/jobs?include_disabled=true` (server root) returns `{ jobs }`. Each job carries `last_run_at`, `last_status`, `failure_streak` and, on newer versions, `latest_execution`. `POST /api/jobs/{id}/pause | resume | run` control a job. A 501 means cron isn't available.
- The API server has **no run-history endpoint** (the dashboard's `/api/cron/jobs/{id}/runs` is localhost-only). Memento keeps every run it sees in `cronRuns`, and backfills from `GET /api/sessions?source=cron`: each agent run leaves a session `cron_<jobId>_<YYYYmmdd_HHMMSS>` whose `end_reason` is `cron_complete` or `cron_incomplete_no_output`. A run that dies on provider errors still ends `cron_complete` (Hermes closes the turn with an assistant row whose `display_kind` is `failed_turn`), so Memento checks each `cron_complete` session's last row once via `GET /api/sessions/{id}/messages?limit=1&order=latest`. Script-only runs and runs that fail before the agent starts leave no session, so the history is best effort.
- If you change how the API is used, update `scripts/mock-hermes.mjs` to match.

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
