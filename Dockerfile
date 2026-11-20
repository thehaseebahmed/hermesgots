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

# GitHub CLI, from GitHub's own apt repository (Debian's packaged gh lags well behind).
RUN install -d -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# `psmisc` is fuser, which `pnpm e2e down` shells out to. Debian 13's python3 is 3.13, the version
# the plugin's tests run on in CI, and they import cryptography the same way — into the
# interpreter itself, not a venv: Debian's /etc/profile rewrites PATH for login shells, so a
# venv's python3 would not be the one `python3 -m unittest` finds. Debian marks the interpreter
# externally managed, hence --break-system-packages.
RUN python3 -m pip install --no-cache-dir --break-system-packages cryptography

# PlatformIO Core, for the Gots Charm firmware (hermesgots-charm, ESP32-S3 / M5Stack StopWatch).
# Installed into the system interpreter for the same login-shell reason as above. The ESP32
# toolchain and libraries are not baked in: PlatformIO fetches them per project on first
# `pio run` into $PLATFORMIO_CORE_DIR, which a user can point at a persistent volume.
RUN python3 -m pip install --no-cache-dir --break-system-packages platformio \
 && pio --version

# The Android app (`app/android`): JDK 21 and the Android SDK, so `./gradlew testDebugUnitTest
# lintDebug assembleDebug` runs here as it runs in `android.yml` (temurin 21 there, Debian's
# OpenJDK 21 here). The SDK holds what the Gradle build asks for: the platform `compileSdkVersion`
# names in `app/android/variables.gradle` (36), the build tools the Android Gradle Plugin 8.13
# defaults to (35.0.0) and the newest for that platform (36.0.0), and platform-tools for adb. Bump
# them with `compileSdkVersion` and the AGP version.
#
# The SDK lives at /opt/android-sdk, which Gradle can also add a missing package to, so it is made
# world-writable. ANDROID_HOME and JAVA_HOME are plain variables, which a login shell keeps.
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ARG ANDROID_CMDLINE_TOOLS=16111833
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-21-jdk-headless \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/cmdline-tools.zip \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" \
 && mkdir -p "$ANDROID_HOME/cmdline-tools" /opt/cmdline-tools \
 && unzip -q /tmp/cmdline-tools.zip -d /opt/cmdline-tools \
 && mv /opt/cmdline-tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
 && rm -rf /opt/cmdline-tools /tmp/cmdline-tools.zip \
 && java -version

# The SDK's `sdkmanager` is a shell wrapper that finds its `android` sibling from its own path, so
# a symlink in /usr/local/bin breaks it ("Could not determine SDK root"). A one-line wrapper that
# execs the real script keeps that path, and a login shell drops ENV PATH entries anyway (see the
# python note above), so /usr/local/bin is where these have to live.
RUN for tool in sdkmanager avdmanager; do \
      printf '#!/bin/sh\nexec %s/cmdline-tools/latest/bin/%s "$@"\n' "$ANDROID_HOME" "$tool" \
        > "/usr/local/bin/$tool"; \
      chmod +x "/usr/local/bin/$tool"; \
    done

# Accept the SDK licenses by writing the hash `sdkmanager --licenses` would record — the option is
# deprecated in these tools and prompts when a new package arrives — then install the packages the
# build needs, and prove they landed.
RUN mkdir -p "$ANDROID_HOME/licenses" \
 && printf 24333f8a63b6825ea9c5514f83c2829b004d1fee > "$ANDROID_HOME/licenses/android-sdk-license" \
 && sdkmanager --install "platform-tools" "platforms;android-36" \
      "build-tools;35.0.0" "build-tools;36.0.0" \
 && ln -s "$ANDROID_HOME/platform-tools/adb" /usr/local/bin/adb \
 && chmod -R a+rwX "$ANDROID_HOME" \
 && sdkmanager --list_installed

# pnpm 10, installed the way CI installs it. Not corepack: neither package.json carries a
# `packageManager` field for corepack to pin from, so it would resolve an unpinned version.
RUN npm install -g --cache /tmp/npm-cache pnpm@10 \
 && rm -rf /tmp/npm-cache

# The e2e flows drive the app in headless Chromium. `app/scripts/e2e/cli.mjs` resolves Playwright
# from `app/node_modules` or the global node_modules, so it is installed globally here.
#
# Playwright is one version, 1.65.1, because two tools in the image drive a browser and a browser
# build belongs to the Playwright revision that asks for it: Reticle bundles its own Playwright
# (`@reticlehq/server` depends on `^1.63.0`, which resolves to this version), and a second one would
# mean a second Chromium — fetched at first launch, mid-session, into the root-owned browsers root.
#
# Chromium is installed whole, not `--only-shell`: Reticle's preflight reads
# `chromium.executablePath()` — the full build — before it will drive anything, and Playwright's
# headless launches then use the headless shell that ships beside it. Shell-only left Reticle
# believing no browser existed and reaching for a download at runtime.
RUN npm install -g --cache /tmp/npm-cache playwright@1.65.1 \
 && playwright install --with-deps chromium \
 && rm -rf /tmp/npm-cache /var/lib/apt/lists/*

# Reticle (https://reticle.sh), the verification CLI an agent drives from inside the container: it
# runs a dev-only SDK in the app's page and answers what actually happened. Pinned to the version the
# app's SDK is pinned to (`app/package.json`), and required to agree with the Playwright above — the
# check fails the build rather than letting a rebuild quietly fetch a second browser that Reticle
# would then want and not find.
RUN npm install -g --cache /tmp/npm-cache @reticlehq/server@3.9.0 \
 && node -e "const v = require('/usr/local/lib/node_modules/@reticlehq/server/node_modules/playwright/package.json').version; if (v !== '1.65.1') { console.error('reticle bundles playwright ' + v + ' but this image pins 1.65.1; bump the pin above so one chromium build serves both'); process.exit(1) }" \
 && rm -rf /tmp/npm-cache

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
LABEL org.opencontainers.image.source="https://github.com/thehaseebahmed/hermesgots" \
      org.opencontainers.image.title="Gots development container" \
      org.opencontainers.image.description="Node 22, pnpm 10, Python 3.13, JDK 21, the Android SDK, Chromium, PlatformIO, the GitHub CLI and the Reticle verification CLI for developing the Gots app, plugin and website" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision=$BUILD_REVISION

WORKDIR /workspace
CMD ["bash"]
