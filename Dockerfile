# syntax=docker/dockerfile:1

# A development container for the whole repository: the app (`app/`), the Hermes plugin
# (`plugin/`) and the public site (`website/`). Node 22 and Python 3.13 are the versions
# `.github/workflows/tests.yml` runs; pnpm 10 is the one `android.yml` pins through
# pnpm/action-setup. The checks run here are the checks that run there.
#
# The repository is expected at /workspace — mount it rather than baking a checkout in, so a
# container never holds a stale copy of the tree.
FROM node:22-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq psmisc unzip xz-utils \
      python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# `psmisc` is fuser, which `pnpm e2e down` shells out to. Debian 13's python3 is 3.13, the version
# the plugin's tests run on in CI, and they import cryptography the same way — into the
# interpreter itself, not a venv: Debian's /etc/profile rewrites PATH for login shells, so a
# venv's python3 would not be the one `python3 -m unittest` finds. Debian marks the interpreter
# externally managed, hence --break-system-packages.
RUN python3 -m pip install --no-cache-dir --break-system-packages cryptography

# pnpm 10, installed the way CI installs it. Not corepack: neither package.json carries a
# `packageManager` field for corepack to pin from, so it would resolve an unpinned version.
RUN npm install -g --cache /tmp/npm-cache pnpm@10 \
 && rm -rf /tmp/npm-cache

# The e2e flows drive the app in headless Chromium. `app/scripts/e2e/cli.mjs` resolves Playwright
# from `app/node_modules` or the global node_modules, so it is installed globally here. Only the
# headless shell is installed: `--headed` needs a display server, which no flow here sets up.
RUN npm install -g --cache /tmp/npm-cache playwright@1.63.0 \
 && playwright install --with-deps chromium --only-shell \
 && rm -rf /tmp/npm-cache /var/lib/apt/lists/*

# Reticle (https://reticle.sh), the verification CLI an agent drives from inside the container: it
# runs a dev-only SDK in the app's page and answers what actually happened. Pinned to the version the
# app's SDK is pinned to (`app/package.json`), because the two halves speak one protocol.
#
# It brings its own Playwright, at a newer revision than the pinned one above, so the browser it
# would want is a second ~190 MiB download — one it would attempt at first launch, mid-session, into
# the root-owned `/opt/ms-playwright` that a container running as another user cannot write. Instead
# it is pointed at the headless shell the e2e step already installs: a container has no display
# server, so that shell is the only browser a launch here could use anyway. The symlink is resolved
# from the pinned Playwright's own revision directory, so a version bump above keeps working, and
# `test -x` fails the build rather than leaving a path that resolves to nothing.
RUN npm install -g --cache /tmp/npm-cache @reticlehq/server@3.9.0 \
 && mkdir -p /usr/local/lib/reticle \
 && ln -sf "$(find "$PLAYWRIGHT_BROWSERS_PATH" -name chrome-headless-shell -type f | head -n 1)" \
      /usr/local/lib/reticle/chromium \
 && test -x /usr/local/lib/reticle/chromium \
 && rm -rf /tmp/npm-cache

# Where `reticle doctor` and every launch find their browser. Set for every shell in the container,
# so an agent gets the same answer in a tool call as a person does at the prompt.
ENV RETICLE_CHROMIUM_PATH=/usr/local/lib/reticle/chromium

# Warm the store from the lockfiles, so an install inside the container is quick and works
# without the registry. Tied to the lockfiles as of build time; `pnpm install` still reconciles
# anything they no longer cover. Deliberately the last heavy step: a dependency bump then
# re-runs this fetch and nothing above it.
COPY app/package.json app/pnpm-lock.yaml /tmp/warm/app/
COPY website/package.json website/pnpm-lock.yaml /tmp/warm/website/
RUN cd /tmp/warm/app && pnpm fetch \
 && cd /tmp/warm/website && pnpm fetch \
 && rm -rf /tmp/warm

ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/thehaseebahmed/memento" \
      org.opencontainers.image.title="Gots development container" \
      org.opencontainers.image.description="Node 22, pnpm 10, Python 3.13, headless Chromium and the Reticle verification CLI for developing the Gots app, plugin and website" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision=$BUILD_REVISION

WORKDIR /workspace
CMD ["bash"]
