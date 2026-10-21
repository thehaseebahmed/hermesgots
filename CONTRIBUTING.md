# Contributing to Gots

Thank you for contributing to Gots! This guide covers development setup, testing, container workflows, and local Android builds.

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

Before creating a pull request, run the following checks. All four must pass:

```bash
pnpm lint        # Run oxlint
pnpm typecheck   # Type-check TypeScript sources
pnpm test        # Unit and component tests
pnpm build       # Build production bundle and generate service worker
```

For formatting:

```bash
pnpm format      # Format code with Prettier and Tailwind CSS class sorter
```

Tests sit in three tiers — unit, component and end-to-end — and a test belongs to the cheapest tier
that would fail for the reason the change can fail. A new end-to-end flow is an argument that the
lower tiers cannot reach the behaviour
(`docs/adr/0019-a-test-belongs-to-the-cheapest-tier-that-would-fail-for-its-reason.md`).

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
python3 -m unittest discover -s plugin/tests -t .
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
