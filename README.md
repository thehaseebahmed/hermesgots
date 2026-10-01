# Memento

A playful, minimal companion app for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It's an installable PWA for phones and tablets, with light and dark themes.

- **Chat** streams replies from Hermes's OpenAI-compatible API, with live tool cards. When Hermes asks to run a dangerous command, an **approval** card (Once / Session / Always / Deny) takes the place of the message bar. Once you answer, the card moves into the thread at the point where Hermes asked.
- **Bots**: 8 fluffy, animated SVG characters (see `/bots`). Bolt is hardcoded for now. The header bot is animated, and the bots next to messages stay still.
- **Settings**: API URL and key, model picker, theme, reply stats, and clearing local data.
- Chats and settings are stored on the device in **IndexedDB** (via Dexie). Theme preference lives in `localStorage` so the first paint doesn't flash.

Built with Vite, React 19, Tailwind v4 and [shadcn/ui](https://ui.shadcn.com) on **Base UI** (the `base-maia` style, plus shadcn's `Message`, `Bubble` and `MessageScroller` chat components).

## Connect Hermes

Add the following to `~/.hermes/.env` and restart the gateway:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=$(openssl rand -hex 32)      # required for per-chat sessions
API_SERVER_CORS_ORIGINS=https://<your-site>.netlify.app
```

Then open **Settings** in Memento, enter `http://localhost:8642/v1` (or your server's URL) and the key, and tap **Test connection**.

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
