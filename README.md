# Memento

<p align="center">
  <a href="https://app.netlify.com/projects/hermes-companion/deploys"><img alt="Netlify Status" src="https://api.netlify.com/api/v1/badges/5e7733ce-e51d-4d60-adc3-c0e5b8fdb5e5/deploy-status"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-black.svg"></a>
</p>

A playful, minimal companion app for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It's an installable PWA for phones and tablets, with light and dark themes.

- **Chat** streams replies from Hermes's OpenAI-compatible API, with live tool cards. When Hermes asks to run a dangerous command, an **approval** card (Once / Session / Always / Deny) takes the place of the message bar. Once you answer, the card moves into the thread at the point where Hermes asked.
- **Voice**: the mic button dictates with the browser's speech recognition and shows the words live. Cancel discards them, Stop drops them into the message bar to edit, and Send sends them straight away. The button only appears in browsers that support it (Chrome, Edge, Safari).
- **Bots**: each bot is a Hermes profile with its own API URL, key and model. Bots sit in a horizontal strip at the top of the sidebar. Tap one to open its latest chat (or a new one if it has none), and new chats go to it. A new bot gets a random image from the 8 glassy SVG characters (soft shapes with an accessory each; see `/bots`), unique until all 8 are taken, and you can change it in Settings. The header bot is animated, and the bots next to messages stay still.
- **Routines** (`/routines`): every Hermes cron job, grouped by bot, with its last 24 runs as status bars and Run now / Pause / Resume. Bots fold away, and the header flags failing and recently failed routines.
- **Settings**: sync, bots (name, image, API URL and key, model picker), theme, reply stats, and clearing local data.
- **Sync** (optional): sign in with GitHub to sync bots and the chat list (titles, Hermes session ids and context use) across devices. It's end-to-end encrypted, so Netlify only ever stores ciphertext. Messages come from Hermes: an open chat picks up turns sent from your other devices, and older messages load on request.
- Bots, chats and settings are stored on the device in **IndexedDB** (via Dexie). Theme preference lives in `localStorage` so the first paint doesn't flash.

Built with Vite, React 19, Tailwind v4 and [shadcn/ui](https://ui.shadcn.com) on **Base UI** (the `base-maia` style, plus shadcn's `Message`, `Bubble` and `MessageScroller` chat components).

## Connect Hermes

Add the following to `~/.hermes/.env` and restart the gateway:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=$(openssl rand -hex 32)      # required for per-chat sessions
API_SERVER_CORS_ORIGINS=https://<your-site>.netlify.app
```

Then open **Settings** in Memento, enter `http://localhost:8642/v1` (or your server's URL) and the key for your first bot, and tap **Test connection**.

**Profiles:** Hermes's API can't list its profiles, so add one bot per profile. Point it at the profile's own gateway, or at `/p/<profile>/v1` on a gateway running with `gateway.multiplex_profiles`. Each profile has its own `API_SERVER_KEY`. A named profile advertises its name on `/v1/models`, so **Test connection** fills in the bot's name.

**HTTPS:** a page served over HTTPS (Netlify) can call `http://localhost`, but browsers block plain-HTTP servers on any other host. To use Hermes from your phone, expose it over HTTPS, for example with Tailscale Serve or a Cloudflare Tunnel, and add that origin to `API_SERVER_CORS_ORIGINS`.

### How it uses the API

- `POST /v1/chat/completions` with `stream: true`. Memento parses Hermes's extra SSE events (`hermes.tool.progress`, `hermes.status`, `approval.request`) alongside the normal chunks.
- Each chat mints its own `X-Hermes-Session-Id` (`memento-<uuid>`), so Hermes keeps one session per chat. Hermes only honours this header when `API_SERVER_KEY` is set. Without a key, Memento sends the full transcript on every turn.
- Approvals are answered with `POST /v1/runs/{completion_id}/approval`.
- Routines use `GET /api/jobs` and `POST /api/jobs/{id}/pause | resume | run`. The API server only reports each job's latest run, so the history is the runs Memento has seen, backfilled from cron sessions (`GET /api/sessions?source=cron`).
- Hermes's tool events carry the tool name and a preview of its arguments, but not its output. Tool cards show what ran and for how long.
- Chats load and catch up from `GET /api/sessions/{id}/messages?order=latest`, 50 rows at a time, so turns sent from another device appear on this one.
- The reply stats line is an estimate (about 4 characters per token, measured over the visible reply).

## Develop

```bash
pnpm install
pnpm mock      # fake Hermes on :8642 (say "clean up" to trigger an approval)
pnpm dev
```

`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format`.

Sync needs Netlify Identity and the `netlify/functions/sync.mts` function, which only run under the Netlify CLI. Use `pnpm dev:netlify` against a linked site to work on it. Under plain `pnpm dev`, the Sync card stays hidden.

UI primitives in `src/components/ui` are shadcn `base-maia` components. Add more with `pnpm dlx shadcn@latest add <name>`.

## Deploy to Netlify

`netlify.toml` is included (build `pnpm build`, publish `dist`, SPA fallback, service-worker cache headers). In Netlify, choose **Add new site → Import an existing project**, pick this repo, and deploy. Then add the site's URL to `API_SERVER_CORS_ORIGINS`.

To turn on sync:

1. **Project configuration → Identity**: enable Identity.
2. **Registration → External providers**: add GitHub.
3. **Registration preferences**: set **Invite only**, then invite yourself, so nobody else can sign in to your deploy.

The function stores data in Netlify Blobs (store `memento-sync`), which needs no setup.

### How sync is encrypted

- One random AES-256-GCM key per account encrypts everything sync uploads: bots (API keys included) and each bot's chat list. Messages stay on your Hermes server.
- The server only keeps that key wrapped by secrets it never sees:
  - a passkey's WebAuthn PRF output, through HKDF
  - a 25-character recovery code, through PBKDF2
- Signing in with GitHub proves who owns the documents but can't decrypt them, and neither can anyone with access to the Netlify project.
- Each document is bound to its account and slot (AES-GCM associated data), so documents can't be swapped around.
- A device keeps a non-extractable copy of the key in IndexedDB, until you sign out or clear local data.
- Passkeys need a browser and authenticator with PRF support (Safari 18+, Chrome, Firefox 139+). Without it, sync uses the recovery code alone.
- Limits:
  - A compromised deploy could ship code that reads the key once you unlock, which is inherent to encryption in a web app.
  - Lose every passkey and the recovery code, and the synced copy can't be recovered. Each device's local copy remains.

## Roadmap

Native iOS/Android builds by wrapping this same app with Capacitor.
