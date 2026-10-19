# Contributing to Gots

Thank you for contributing to Gots! This guide covers development setup, testing, container workflows, Android builds, and release processes.

## Development Setup

The web application lives in `app/`.

### Prerequisites

- Node.js 22+
- pnpm 10+
- Python 3.13+ (for testing the Hermes plugin)

### Quickstart

```bash
cd app
pnpm install
pnpm mock      # Fake Hermes API on http://localhost:8642 (say "clean up" to trigger an approval)
pnpm dev       # Start Vite dev server on http://localhost:5173
```

### Verification & Testing

Before creating a pull request, run the following checks. All three must pass:

```bash
pnpm lint        # Run oxlint
pnpm typecheck   # Type-check TypeScript sources
pnpm build       # Build production bundle and generate service worker
```

For formatting:

```bash
pnpm format      # Format code with Prettier and Tailwind CSS class sorter
```

### Browser E2E Flows

To test chat, sessions, approvals, and sync flows against the mock API server:

```bash
pnpm e2e list             # List available e2e test flows
pnpm e2e all              # Run all e2e flows
pnpm e2e chat-message     # Run a specific flow
pnpm e2e shot <path>      # Capture a screenshot of a screen
```

To run plugin unit tests:

```bash
python3 -m unittest discover -s plugin/tests
```

### Sync with Netlify Identity

Sync requires Netlify Identity and the Netlify functions runtime (`netlify/functions/sync.mts`). To run with Netlify Identity and Blobs:

```bash
pnpm dev:netlify
```

Under plain `pnpm dev`, the Sync card stays hidden and sign-in is not required.

---

## Development Container

A Docker container image (`ghcr.io/thehaseebahmed/gots-dev:latest`) is available with all required toolchains (Node 22, pnpm 10, Python 3.13, headless Chromium):

```bash
docker pull ghcr.io/thehaseebahmed/gots-dev:latest
```

To build locally and run an interactive shell:

```bash
docker build -t gots-dev .
docker run --rm -it -p 15173:15173 -p 8642:8642 -v "$PWD:/workspace" -w /workspace gots-dev
# Inside container:
cd app && pnpm install && pnpm dev -- --host 0.0.0.0
```

To run the exact test suite executed by CI:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace gots-dev bash .github/scripts/checks.sh all
```

To run browser E2E flows inside Docker:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace gots-dev sh -lc '
  cd app && pnpm install --frozen-lockfile
  pnpm exec vite --port 15173 --strictPort --host 127.0.0.1 &
  until curl -sf http://127.0.0.1:15173 >/dev/null; do sleep 0.5; done
  pnpm e2e chat-message --app http://127.0.0.1:15173'
```

---

## Android App Development

The Android wrapper lives in `android/` and uses [Capacitor](https://capacitorjs.com).

### Local Android Build

Requires JDK 21 and the Android SDK:

```bash
cd app
VITE_SITE_URL=https://<your-site>.netlify.app pnpm build:android
pnpm exec cap open android   # Opens in Android Studio
# Or build debug APK directly via Gradle:
cd android && ./gradlew assembleDebug
```

### Signing & Keystore Configuration

To create a signing key:

```bash
keytool -genkeypair -v -keystore memento.keystore -alias memento -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 memento.keystore   # macOS: base64 -i memento.keystore
```

Add the following to GitHub repository **Settings → Secrets and variables → Actions**:

- **Secrets**:
  - `ANDROID_KEYSTORE_BASE64`: Base64 encoded keystore file.
  - `ANDROID_KEYSTORE_PASSWORD`: Password for keystore.
  - `ANDROID_KEY_ALIAS`: Alias name.
  - `ANDROID_KEY_PASSWORD`: Password for key alias.
- **Variables**:
  - `MEMENTO_SITE_URL`: Netlify production site URL (`https://<your-site>.netlify.app`).
  - `MEMENTO_CANDIDATE_URL`: (Optional) Netlify candidate branch deploy URL (`https://candidate--<your-site>.netlify.app`).

### Firebase App Distribution for Testers

Pushes to `main` automatically publish debug APKs to Firebase App Distribution when configured:

1. Create a service account in Google Cloud IAM with **Firebase App Distribution Admin** (`roles/firebaseappdistro.admin`) and download its JSON key.
2. In GitHub repository Actions secrets/variables:
   - Secret: `FIREBASE_SERVICE_ACCOUNT` (the JSON key text or base64).
   - Variable: `FIREBASE_TESTER_GROUPS` (e.g., `testers`).
   - Variable: `FIREBASE_APP_ID` (e.g., `1:...:android:...`).

---

## Git & Pull Request Guidelines

### Conventional Commits

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <imperative summary, lower case, no trailing period>

<optional body: what changed and why>
```

- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Scopes**: `chat`, `settings`, `bots`, `hermes`, `db`, `pwa`, `ui`, `deps`.
- **Breaking changes**: Append `!` after type/scope and include `BREAKING CHANGE:` in the commit footer.
- Keep the summary line under 72 characters.

### PR Process

Fill in `.github/pull_request_template.md` for all pull requests. Ensure all automated CI checks pass.

---

## Release Process

Releases are created as annotated dated tags on `main` (e.g., `v2026.10.19`) triggered via GitHub Actions:

1. Navigate to **Actions → Release → Run workflow**.
2. Leave the date blank for today's date, or specify a date.
3. The release workflow validates that version bumps exist for modified packages (`app/package.json` and plugin versioning) via `.github/scripts/release.mjs`.
4. If valid, the tag is pushed, triggering automated production deployment and signed Android release APK builds.
