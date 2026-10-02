# Memento

<p align="center">
  <a href="https://app.netlify.com/projects/hermes-companion/deploys"><img alt="Netlify Status" src="https://api.netlify.com/api/v1/badges/5e7733ce-e51d-4d60-adc3-c0e5b8fdb5e5/deploy-status"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-black.svg"></a>
</p>

A playful, minimal companion app for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It's an installable PWA for phones and tablets, with light and dark themes.

- **Chat** streams replies from Hermes's OpenAI-compatible API, with live tool cards. When Hermes asks to run a dangerous command, an **approval** card (Once / Session / Always / Deny) takes the place of the message bar. Once you answer, the card moves into the thread at the point where Hermes asked.
- **Bots**: each bot is a Hermes profile with its own API URL, key and model. Bots sit in a horizontal strip at the top of the sidebar. Tap one to see its chats, and new chats go to it. A new bot gets a random image from the 8 glassy SVG characters (soft shapes with an accessory each; see `/bots`), unique until all 8 are taken, and you can change it in Settings. The header bot is animated, and the bots next to messages stay still.
- **Settings**: bots (name, image, API URL and key, model picker), theme, reply stats, and clearing local data.
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
- Hermes's tool events carry the tool name and a preview of its arguments, but not its output. Tool cards show what ran and for how long.
- The reply stats line is an estimate (about 4 characters per token, measured over the visible reply).

## Develop

```bash
pnpm install
pnpm mock      # fake Hermes on :8642 (say "clean up" to trigger an approval)
pnpm dev
```

`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format`.

UI primitives in `src/components/ui` are shadcn `base-maia` components. Add more with `pnpm dlx shadcn@latest add <name>`.

## Deploy to Netlify

`netlify.toml` is included (build `pnpm build`, publish `dist`, SPA fallback, service-worker cache headers). In Netlify, choose **Add new site → Import an existing project**, pick this repo, and deploy. Then add the site's URL to `API_SERVER_CORS_ORIGINS`.

## Roadmap

Native iOS/Android builds by wrapping this same app with Capacitor.
