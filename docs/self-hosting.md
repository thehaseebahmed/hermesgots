# Self-hosting Gots

Gots is three pieces: the app, an optional sync server, and your Hermes host. Self-hosting means running the first two yourself instead of opening [app.hermesgots.dev](https://app.hermesgots.dev) — your chats and your bots' work already live on your own host either way.

What you get out of it is your own copy of the app and your own encrypted vault, so nothing about your accounts passes through anyone else's deployment. What you take on is running it: the Netlify site, its Identity provider, and — if you want an APK of your own — the Android build.

This guide is the whole path, in the order you need it.

## What you need

- A Netlify account and this repository.
- A machine with Node 22 and pnpm 10 to build locally (Netlify does its own builds; this is for an Android APK or a local check).
- A Hermes host, 0.22.5 or newer, with the Gots plugin. That part is yours whether or not you self-host.
- Optional, for an APK: JDK 21 and the Android SDK, plus a Firebase project if you want push notifications on Android.

## 1. Deploy the app and the sync server

The site and the sync server are the same Netlify deploy: `netlify.toml` at the repository root builds `app/` (`pnpm build`, publish `dist`), serves the three functions in `app/netlify/functions` — `registry`, `sync` and `community` — and rewrites everything else to `index.html`.

1. In Netlify, **Add new site → Import an existing project**, pick your fork. The build settings come from `netlify.toml`; leave them alone.
2. Let the site deploy once. Note its address — everything below uses it.

> **Two ways to deploy.** This is how a fork works with nothing set up. The upstream project instead builds in GitHub Actions and publishes by hand (`.github/workflows/deploy.yml`), with Netlify's own Git builds switched off for its site; that path needs `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` as repository secrets. Either is fine — pick one and keep it.

### Turn on Identity

The sync server and the Android app both authenticate through Netlify Identity, and a deploy with Identity on puts the app behind sign-in.

- **Project configuration → Identity**: enable it.
- **Registration → External providers**: add GitHub.
- **Registration preferences**: **Invite only**, then invite yourself, and anyone else you want on your deployment.

### Storage

Nothing to set up. The registry and sync functions keep their records in [Netlify Blobs](https://docs.netlify.com/blobs/overview/) through `getStore`, and Blobs needs no configuration beyond the site existing.

What lands there is sealed on the device before it arrives: the bot list, connection details and settings are encrypted with a data key that only your passkey or recovery code unwraps. The functions store ciphertext and counts, and cannot read either.

### Environment variables

Set these under **Project configuration → Environment variables**. Only the first matters for the app itself; the rest are for Android push and the community leaderboard.

| Variable | Needed for | What it is |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | Android push | A Firebase service account's JSON, with permission to send through Cloud Messaging. It stays in the function: a phone never holds it, and neither does a Hermes host. |
| `GITHUB_TOKEN` | Community leaderboard | Optional. Lifts GitHub's rate limit when the function looks up a username from its account id. |

`URL` is Netlify's own and is already there.

### A domain

If you point a custom domain at the site, use it everywhere from here on: in `API_SERVER_CORS_ORIGINS`, in the `--site` you link with, and in the Android build below. A mismatch shows up as a failed fetch the app cannot explain.

## 2. Point your host at your deployment

On the Hermes host:

```bash
hermes plugins install thehaseebahmed/hermesgots/plugin --enable
hermes gateway restart
```

Then, in your copy of the app, choose **Link a bot** and run the command it shows, with your own address:

```bash
hermes gots link <code> --site https://your-site.example
```

Linking is also where the API server gets sorted out. The command prints whichever of these your profile's `.env` is missing, offers to write them, and asks you for a gateway restart:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=<64 characters>
API_SERVER_CORS_ORIGINS=https://your-site.example
```

If you would rather write them by hand, `API_SERVER_KEY` is any 64-character string — `openssl rand -hex 32` makes one — and the app sends it as its bearer token. Keep the origin list exact: scheme and host, no trailing slash.

To link another profile as a second bot, install the plugin there too and point the app at `/p/<profile>/v1` with that profile's key. [The plugin's README](../plugin/README.md) covers what those routes do.

## 3. Build the Android app yourself

The APK is a Capacitor wrapper around the same web build, so a self-hosted APK is a build of your own site.

### Debug build, for one phone

```bash
cd app
pnpm install
VITE_SITE_URL=https://your-site.example pnpm build:android   # vite build --mode native, then cap sync android
pnpm exec cap open android
```

From Android Studio, Run. Or from the command line, which leaves an APK you can sideload:

```bash
cd app/android
./gradlew assembleDebug
```

The debug APK lands at `app/android/app/build/outputs/apk/debug/app-debug.apk`. `allowMixedContent` is on, so a host on a LAN or Tailscale over plain HTTP works from it.

`VITE_SITE_URL` is the APK's own address, and it is baked in at build time: the web app uses whatever origin served it, while the native build has no origin to ask, so this is how it finds your deployment's registry when it links a bot. Leave it out and linking has nowhere to go.

### A release build

Three things separate a release APK from a debug one: the build points at production, it is signed with a keystore you keep, and it carries a version code that increases so it installs over the last one.

```bash
# Once: a keystore. Keep it; every future build has to use it to update in place.
keytool -genkeypair -v -keystore gots-release.jks -alias gots \
  -keyalg RSA -keysize 4096 -validity 10000

cd app
VITE_SITE_URL=https://your-site.example \
ANDROID_VERSION_CODE=2 ANDROID_VERSION_NAME=0.1.0 \
  pnpm build:android

cd android
ANDROID_KEYSTORE_PATH="$PWD/../../gots-release.jks" \
ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=gots ANDROID_KEY_PASSWORD=… \
  ./gradlew assembleRelease
```

`app/android/app/build.gradle` signs a release build only when `ANDROID_KEYSTORE_PATH` is set; without it the APK comes out unsigned. The version code has to go up with every install; `app/package.json`'s `version` is what releases derive theirs from, and setting `ANDROID_VERSION_CODE` and `ANDROID_VERSION_NAME` overrides it for a hand build.

`VITE_SITE_URL` is read only by the native build — the web app uses whatever origin served it — and it is what the APK uses to name your deployment when it links a bot.

### Building it in CI instead

`.github/workflows/android-release.yml` builds a signed APK for a dated tag (`v2026.09.17`), and `.github/workflows/android.yml` builds one per push to main for the Firebase tester group. To use them in your fork, set these repository secrets and variables:

| Name | Kind | For |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | secret | your keystore, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | secrets | that keystore |
| `FIREBASE_GOOGLE_SERVICES` | secret | `google-services.json`, as JSON or base64 — without it the APK builds and has no Android push |
| `FIREBASE_SERVICE_ACCOUNT` | secret | the same service account as on Netlify, for App Distribution |
| `MEMENTO_SITE_URL` | variable | your site's address, passed to the build as `VITE_SITE_URL` (the name predates Gots; it is still what the workflows read) |
| `FIREBASE_APP_ID`, `FIREBASE_TESTER_GROUPS` | variables | which Firebase app to distribute to, and to whom |
| `SENTRY_DSN` | variable | optional, crash reports |

## 4. Push notifications

There are two transports, and the app can use either.

- **ntfy**, from your host: set `NTFY_SERVER_URL` and `NTFY_TOKEN` in the profile's `.env`, then join the phone in **Settings → Notifications → ntfy**. Nothing leaves your infrastructure except what ntfy itself carries.
- **Firebase**, from your Netlify site: the Android build needs `google-services.json` at `app/android/app/google-services.json`, and the site needs `FIREBASE_SERVICE_ACCOUNT`. The plugin then asks the registry to send, so the service account key stays on the function and never on a host or a phone.

A PWA on a desktop or an Android phone can also subscribe to browser push, which needs no Firebase at all.

## Checklist

- [ ] Site deployed, and its address noted.
- [ ] Identity on, GitHub added as a provider, registration invite-only.
- [ ] You are invited and can sign in.
- [ ] `FIREBASE_SERVICE_ACCOUNT` set, if you want Android push.
- [ ] `API_SERVER_ENABLED`, `API_SERVER_KEY` and `API_SERVER_CORS_ORIGINS` in the profile's `.env`, with the gateway restarted after.
- [ ] `hermes gots link … --site https://your-site` succeeded and the bot shows in the app.
- [ ] Android build has `VITE_SITE_URL` pointing at the same address.

## When it doesn't work

| What you see | What it usually is |
| --- | --- |
| The app opens to a sign-in screen you can't get past | Identity is on but you aren't invited, or the GitHub provider isn't added. |
| `Failed to fetch` on every request, on a phone only | The host is on `http://` behind an `https://` page; use HTTPS (Tailscale Serve, a tunnel), and add that origin to `API_SERVER_CORS_ORIGINS`. |
| A bot links, then shows as offline | The gateway wasn't restarted after the `.env` lines were written, so the API server isn't listening. |
| Function answers 401 | The session expired, or the Android build's `VITE_SITE_URL` names a different site than the one you're signed in to. |
| Nothing arrives on Android, web push works | `google-services.json` wasn't in the APK's build, or `FIREBASE_SERVICE_ACCOUNT` is unset, or the FCM registration hasn't happened yet (it happens at app start). |
| An APK won't install over the last one | Its version code didn't increase. |
