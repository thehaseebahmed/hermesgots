# syntax=docker/dockerfile:1

# A development container for the whole repository: the app (`app/`), the Hermes plugin
# (`plugin/`) and the public site (`website/`). The versions match the ones CI pins in
# `.github/workflows/tests.yml`, so the checks run here are the checks that run there.
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
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

# `psmisc` is fuser, which `pnpm e2e down` shells out to. Debian 13's python3 is 3.13, the version
# the plugin's tests run on in CI, and they import cryptography the same way — into the
# interpreter itself, not a venv: Debian's /etc/profile rewrites PATH for login shells, so a
# venv's python3 would not be the one `python3 -m unittest` finds. Debian marks the interpreter
# externally managed, hence --break-system-packages.
RUN python3 -m pip install --no-cache-dir --break-system-packages cryptography

# pnpm 10, installed the way CI installs it. Not corepack: neither package.json carries a
# `packageManager` field for corepack to pin from, so it would resolve an unpinned version.
RUN npm install -g pnpm@10

# Warm the store from the lockfiles, so an install inside the container is quick and works
# without the registry. Tied to the lockfiles as of build time; `pnpm install` still reconciles
# anything they no longer cover.
COPY app/package.json app/pnpm-lock.yaml /tmp/warm/app/
COPY website/package.json website/pnpm-lock.yaml /tmp/warm/website/
RUN cd /tmp/warm/app && pnpm fetch \
 && cd /tmp/warm/website && pnpm fetch \
 && rm -rf /tmp/warm

# The e2e flows drive the app in headless Chromium. `app/scripts/e2e/cli.mjs` resolves Playwright
# from `app/node_modules` or the global node_modules, so it is installed globally here, with
# Chromium and the system libraries it needs.
RUN npm install -g playwright@1.63.0 \
 && playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/thehaseebahmed/memento" \
      org.opencontainers.image.title="Gots development container" \
      org.opencontainers.image.description="Node 22, pnpm 10, Python 3.13 and headless Chromium for developing the Gots app, plugin and website" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision=$BUILD_REVISION

WORKDIR /workspace
CMD ["bash"]
