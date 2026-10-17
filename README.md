# Gots

<p align="center">
  <a href="https://app.netlify.com/projects/hermes-companion/deploys"><img alt="Netlify Status" src="https://api.netlify.com/api/v1/badges/5e7733ce-e51d-4d60-adc3-c0e5b8fdb5e5/deploy-status"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-black.svg"></a>
</p>

A playful, minimal companion app for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It's an installable PWA for phones and tablets, with light and dark themes.

- **Chat** streams replies from Hermes's OpenAI-compatible API, with live tool cards. When Hermes asks to run a dangerous command, an **approval** card (Once / Session / Always / Deny) takes the place of the message bar. Once you answer, the card moves into the thread at the point where Hermes asked.
- **Todos**: when the agent plans multi-step work, a "2/5 todos" pill above the message bar shows its progress, and tapping it opens the list. The agent keeps the list; it needs the [Gots plugin](plugin/README.md).
- **Voice**: the mic button records you and the bot's own Hermes host turns it into text with its local faster-whisper model. Tap to start and stop, or hold and let go. Cancel discards the recording, Stop drops the text into the message bar to edit, and Send sends it straight away. The button only appears for a bot whose host has faster-whisper installed (`hermes tools`, then Local Whisper under Speech-to-Text) and the Gots plugin 0.34 or newer.
- **Bots**: each bot is a Hermes profile with its own API URL, key and model. Bots sit in a horizontal strip at the top of the sidebar. Tap one to open its latest chat (or a new one if it has none), and new chats go to it. A new bot gets a random image from the 8 glassy SVG characters (soft shapes with an accessory each; see `/bots`), unique until all 8 are taken, and you can change it in Settings. The header bot is animated, and the bots next to messages stay still.
- **Routines** (`/routines`): every Hermes cron job, grouped by bot, with its last 24 runs as status bars and Run now / Pause / Resume. Run history comes from the [Gots plugin](plugin/README.md) on your Hermes server, so every device sees the same runs. Bots fold away, and the header flags failing and recently failed routines.
- **Settings**: sync, bots (name, image, API URL and key, model picker, whether its Gots plugin is in use), theme, reply stats, and clearing local data.
- **Sync**: each bot's chat list (titles, Hermes session ids and context use) is saved on its Hermes server by the [Gots plugin](plugin/README.md). On a deploy with Netlify Identity, you sign in with GitHub and turn on (or unlock) sync before the app opens. It syncs bots across devices, and the chat list of any bot whose server doesn't have the plugin (Settings flags those bots). It's end-to-end encrypted, so Netlify only ever stores ciphertext. Messages come from Hermes: an open chat picks up turns sent from your other devices, and older messages load on request.
- **First-run setup** walks through signing in, turning on sync, enabling Hermes's API server (from its `.env` file or the Hermes Dashboard) and connecting the first bot. A device whose bots arrive through sync skips the Hermes steps.
- Bots, chats and settings are stored on the device in **IndexedDB** (via Dexie). Theme preference lives in `localStorage` so the first paint doesn't flash.

Built with Vite, React 19, Tailwind v4 and [shadcn/ui](https://ui.shadcn.com) on **Base UI** (the `base-maia` style, plus shadcn's `Message`, `Bubble` and `MessageScroller` chat components).

## Connect Hermes

Add the following to `~/.hermes/.env` and restart the gateway:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=<your 64-character key>    # required; generate one with `openssl rand -hex 32`
API_SERVER_CORS_ORIGINS=https://<your-site>.netlify.app
```

Or, in the Hermes Dashboard (`hermes dashboard`): **Channels → API server → Configure**, turn it on, set the auth key, and **Restart gateway**. The dashboard has no CORS field, so `API_SERVER_CORS_ORIGINS` still goes in `~/.hermes/.env`.

Gots's first-run setup shows both routes, with this site's origin filled in, then connects your first bot (`http://localhost:8642/v1` or your server's URL) with **Test connection**. Add more bots later in **Settings**.

Also install the [Gots plugin](plugin/README.md). It keeps each bot's chat list on its Hermes server, serves **Routines**, and labels your chats **Gots** in the Hermes dashboard:

```bash
hermes plugins install thehaseebahmed/memento/plugin --enable
hermes gateway restart
```

**Profiles:** Hermes's API can't list its profiles, so add one bot per profile. Point it at the profile's own gateway, or at `/p/<profile>/v1` on a gateway running with `gateway.multiplex_profiles`. Each profile has its own `API_SERVER_KEY`. A named profile advertises its name on `/v1/models`, so **Test connection** fills in the bot's name. The plugin reaches a `/p/<profile>` bot too, but it has to be installed and enabled in that profile as well (`hermes -p <profile> plugins install thehaseebahmed/memento/plugin --enable`), then `hermes gateway restart`.

**HTTPS:** a page served over HTTPS (Netlify) can call `http://localhost`, but browsers block plain-HTTP servers on any other host. To use Hermes from your phone, expose it over HTTPS, for example with Tailscale Serve or a Cloudflare Tunnel, and add that origin to `API_SERVER_CORS_ORIGINS`.

### How it uses the API

- `POST /v1/chat/completions` with `stream: true`. Gots parses Hermes's extra SSE events (`hermes.tool.progress`, `hermes.status`, `approval.request`) alongside the normal chunks.
- Each chat mints its own `X-Hermes-Session-Id` (`memento-<uuid>`), so Hermes keeps one session per chat. Hermes only honours this header when `API_SERVER_KEY` is set. Without a key, Gots sends the full transcript on every turn.
- Approvals are answered with `POST /v1/runs/{completion_id}/approval`.
- Routines use `GET /api/jobs` and `POST /api/jobs/{id}/pause | resume | run`. The API server only reports each job's latest run, so the run history comes from the Gots plugin's `GET /api/plugins/memento/cron/runs`, which reads Hermes's cron execution ledger.
- With the plugin, Gots marks each chat's session as `memento` (`POST /api/plugins/memento/sessions/{id}/label`) after its first turns, so the Hermes dashboard labels it **Gots** instead of **API server**.
- Hermes's tool events carry the tool name and a preview of its arguments, but not its output. Tool cards show what ran and for how long.
- Chats load and catch up from `GET /api/sessions/{id}/messages?order=latest`, 50 rows at a time, so turns sent from another device appear on this one.
- The reply stats line is an estimate (about 4 characters per token, measured over the visible reply).

## Develop

The app lives in `app/`.

```bash
cd app
pnpm install
pnpm mock      # fake Hermes on :8642 (say "clean up" to trigger an approval)
pnpm dev
```

`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format`.

Sync needs Netlify Identity and the `netlify/functions/sync.mts` function, which only run under the Netlify CLI. Use `pnpm dev:netlify` against a linked site to work on it. Under plain `pnpm dev`, the Sync card stays hidden and sign-in isn't required.

UI primitives in `src/components/ui` are shadcn `base-maia` components. Add more with `pnpm dlx shadcn@latest add <name>`.

### Development container

`Dockerfile` builds an image with everything the app, the plugin and the website need — Node 22, pnpm 10, Python 3.13 (with the plugin tests' `cryptography`) and headless Chromium for the e2e flows. `.github/workflows/dev-image.yml` builds it on every pull request and publishes it on a push to `main`:

```bash
docker pull ghcr.io/thehaseebahmed/gots-dev:latest
```

Or build it yourself and mount the repository at `/workspace`; the image carries the toolchains, never a copy of the tree:

```bash
docker build -t gots-dev .
docker run --rm -it -p 15173:15173 -p 8642:8642 -v "$PWD:/workspace" -w /workspace gots-dev
# inside the container: cd app && pnpm install && pnpm dev -- --host 0.0.0.0
```

The app's checks, run in the container:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace gots-dev sh -lc "cd app && pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && node scripts/test-community.mjs && pnpm build"
```

The plugin's and the website's take the same shape — `python3 -m unittest discover -s plugin/tests`, and `cd website && pnpm install --frozen-lockfile && pnpm build`. `dev-image.yml` runs them against the image itself; `AGENTS.md` lists them for a host checkout.

An e2e flow drives the dev server itself, so start it bound to IPv4 in the same container first: the harness probes the port over IPv4 while Vite binds `::1` unless told otherwise — the trap `.agents/skills/e2e-testing/` lists under Gotchas.

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace gots-dev sh -lc '
  cd app && pnpm install --frozen-lockfile
  pnpm exec vite --port 15173 --strictPort --host 127.0.0.1 &
  until curl -sf http://127.0.0.1:15173 >/dev/null; do sleep 0.5; done
  pnpm e2e chat-message --app http://127.0.0.1:15173'
```

The container runs as root, so an install inside it leaves root-owned `node_modules` and `dist` in the mounted tree. `.agents/skills/e2e-testing/` lists which server takes which port; publish the ones you need with `-p`. The Android APK is not built here: see [Android app](#android-app).

## Deploy to Netlify

`netlify.toml` is included (base `app`, build `pnpm build`, publish `dist`, SPA fallback, service-worker cache headers). In Netlify, choose **Add new site → Import an existing project**, pick this repo, and deploy. Then add the site's URL to `API_SERVER_CORS_ORIGINS`.

To turn on sync:

1. **Project configuration → Identity**: enable Identity.
2. **Registration → External providers**: add GitHub.
3. **Registration preferences**: set **Invite only**, then invite yourself, so nobody else can sign in to your deploy.

The function stores data in Netlify Blobs (store `memento-sync`), which needs no setup.

### How sync is encrypted

- One random AES-256-GCM key per account encrypts everything sync uploads: bots (API keys included) and the chat list of each bot without the Gots plugin. Messages, and the chat lists the plugin keeps, stay on your Hermes server.
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

## Android app

`android/` wraps this same app with [Capacitor](https://capacitorjs.com). Two workflows build it:

- **Android** (`.github/workflows/android.yml`) builds a debug APK on every push to `main`, and checks a pull request with Gradle's `lintDebug` — building the APK too when the native project or `capacitor.config.ts` moved. Builds from `main` also go to testers (below).
- **Android release** (`.github/workflows/android-release.yml`) builds the signed release APK. It runs when a version tag is pushed, and the tag becomes the app's version, so it must match `app/package.json`: set the version there, commit, then tag that commit (`git tag v0.1.0-beta && git push origin v0.1.0-beta`). To run it again, pick the tag (or a branch whose head carries it) under **Actions → Android release → Run workflow**. The APK is attached to the run and to the tag's GitHub release, which is created as a prerelease when the version has a suffix like `-beta`.

One-time setup:

1. Create a signing key and keep it safe. Updates only install over a build signed with the same key.

   ```bash
   keytool -genkeypair -v -keystore memento.keystore -alias memento -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 memento.keystore   # macOS: base64 -i memento.keystore
   ```

2. In the repo's **Settings → Secrets and variables → Actions**, add:
   - secrets: `ANDROID_KEYSTORE_BASE64` (the output above), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
   - variable: `MEMENTO_SITE_URL`, your Netlify deploy (e.g. `https://<your-site>.netlify.app`). The app signs in and syncs through it. Leave it unset to build without sync.
3. Add `https://localhost` (the app's origin) to `API_SERVER_CORS_ORIGINS` on each Hermes server.

Debug builds are signed with the same key when the secret is there, so each one installs over the last; without it (e.g. pull requests from forks) they use a throwaway debug key. A release won't build without the key. A release's version code comes from its tag and is always higher than a debug build's, so a release installs over a debug build but not the other way round.

### Testers (Firebase App Distribution)

Pushes to `main` also send the debug APK to testers through [Firebase App Distribution](https://firebase.google.com/docs/app-distribution). Testers get an email for each build and install it with the App Tester app. Pull requests are never distributed. Until the secret below exists, the step is skipped.

One-time setup, in the Firebase project that already holds the `app.memento` Android app (the one `FIREBASE_GOOGLE_SERVICES` comes from):

1. In the Firebase console, open **App Distribution**, accept its terms, and under **Testers & Groups** create a group (e.g. `testers`) and add the testers' emails.
2. In Google Cloud's **IAM & Admin → Service accounts** for the same project, create a service account with the **Firebase App Distribution Admin** role (`roles/firebaseappdistro.admin`) and download a JSON key for it.
3. Add to the repo's Actions settings:
   - secret: `FIREBASE_SERVICE_ACCOUNT`, that key's JSON (as is, or base64). The same key goes in Netlify's `FIREBASE_SERVICE_ACCOUNT` so the registry can send push notifications with it; for that the account also needs **Firebase Cloud Messaging API Admin**.
   - variable (optional): `FIREBASE_TESTER_GROUPS`, the group aliases to send to, comma-separated (default `testers`).
   - variable (optional): `FIREBASE_APP_ID`, the app's id (`1:…:android:…`). By default it's read from `FIREBASE_GOOGLE_SERVICES`.

Each build's release notes are its version and the commit message. Distribution needs the keystore secrets too, since testers can only update over a build signed with the same key. Releases aren't distributed this way; they're on GitHub.

In the app:

- Plain-HTTP Hermes servers on other hosts work, since the app isn't bound by the browser's mixed-content rule.
- Sign-in opens GitHub in a browser tab and returns to the app.
- Passkeys belong to the website's domain, so the app unlocks sync with the recovery code.

To build locally (needs JDK 21 and the Android SDK):

```bash
cd app
VITE_SITE_URL=https://<your-site>.netlify.app pnpm build:android
pnpm exec cap open android   # or: cd android && ./gradlew assembleDebug
```

## Roadmap

A native iOS build from the same Capacitor project.
