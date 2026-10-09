# Self-hosting and development

Everything you need to run your own copy of Memento, build the Android app, or work on the code. To just use Memento, see the [README](../README.md).

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

## Deploy to Netlify

`netlify.toml` is included (base `app`, build `pnpm build`, publish `dist`, SPA fallback, service-worker cache headers). In Netlify, choose **Add new site → Import an existing project**, pick this repo, and deploy. Your link screen then shows `--site https://<your-site>.netlify.app`, and the link command adds that origin to each Hermes host's `API_SERVER_CORS_ORIGINS`.

To turn on sync:

1. **Project configuration → Identity**: enable Identity.
2. **Registration → External providers**: add GitHub.
3. **Registration preferences**: set **Invite only**, then invite yourself, so nobody else can sign in to your deploy.

The functions store data in Netlify Blobs (stores `memento-sync` and `memento-registry`), which needs no setup. To push notifications to the Android app, also set the environment variable `FIREBASE_SERVICE_ACCOUNT` (see **Testers** below for the key).

### How sync is encrypted

- One random AES-256-GCM key per account encrypts everything sync uploads: what you changed about each bot (name, image, default model) and the private half of the account's inbox key. Messages and chat lists stay on your Hermes server, with the Memento plugin.
- A linked bot's record (its address and API key) is sealed to the inbox key on the Hermes host before it reaches the registry, so the registry can't read it either.
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

- **Android** (`.github/workflows/android.yml`) builds a debug APK on every push to `main` and every push to a pull request into `main`, and attaches it to the run as an artifact (`memento-<commit>`). Builds from `main` also go to testers (below).
- **Android release** (`.github/workflows/android-release.yml`) builds the signed release APK. It only runs by hand, and only on a version tag, which becomes the app's version: tag a commit (`git tag v0.1.0-beta && git push origin v0.1.0-beta`), then pick the tag (or a branch whose head carries it) under **Actions → Android release → Run workflow**. The APK is attached to the run and to the tag's GitHub release, which is created as a prerelease when the version has a suffix like `-beta`.

One-time setup:

1. Create a signing key and keep it safe. Updates only install over a build signed with the same key.

   ```bash
   keytool -genkeypair -v -keystore memento.keystore -alias memento -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 memento.keystore   # macOS: base64 -i memento.keystore
   ```

2. In the repo's **Settings → Secrets and variables → Actions**, add:
   - secrets: `ANDROID_KEYSTORE_BASE64` (the output above), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
   - variable: `MEMENTO_SITE_URL`, your Netlify deploy (e.g. `https://<your-site>.netlify.app`). The app signs in and syncs through it. Leave it unset to build without sync.
3. The app's origin is `https://localhost`. The link command adds it to `API_SERVER_CORS_ORIGINS` on each Hermes host.

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
- Voice input uses Android's own speech recognizer, since the WebView has no Web Speech API.

To build locally (needs JDK 21 and the Android SDK):

```bash
cd app
VITE_SITE_URL=https://<your-site>.netlify.app pnpm build:android
pnpm exec cap open android   # or: cd android && ./gradlew assembleDebug
```
