#!/usr/bin/env bash
# The check set, in one place: the app's gates, the plugin's tests, the website's build and the CI's
# own tests.
#
#   usage: checks.sh app|plugin|website|ci|all         (from the repository root)
#
# `tests.yml` runs one area per job and the development image runs `all`, to prove the image can run
# what CI runs. A gate added here reaches both callers; the list used to exist in two places, and had
# already drifted by the time the image was written. Each environment supplies its own toolchain —
# the runner through `actions/setup-node` and `actions/setup-python`, the image through its own
# layers — so this script calls the tools and never installs them.
set -euo pipefail

for dir in app plugin website; do
  if [ ! -d "$dir" ]; then
    echo "checks.sh: run from the repository root (no $dir/ here)" >&2
    exit 1
  fi
done

# One gate per line of the log: a collapsible group on Actions, a plain header anywhere else (the
# image's output has no annotations to read).
gate() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "== $*"; fi
  "$@"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi
}

app() {
  cd app
  gate pnpm install --frozen-lockfile
  gate pnpm lint
  gate pnpm typecheck
  gate node scripts/test-community.mjs
  gate node --experimental-strip-types --test scripts/test-bench-matching.mjs scripts/test-benchlm-check.mjs
  gate node --experimental-strip-types --test scripts/test-identity-session.mjs
  gate node --experimental-strip-types --test scripts/test-slash.mjs scripts/test-skills-cache.mjs
  gate pnpm build
}

plugin() {
  # `cryptography` is the environment's to install: the workflow adds it, the image carries it.
  gate python3 -m unittest discover -s plugin/tests
}

website() {
  cd website
  gate pnpm install --frozen-lockfile
  gate pnpm build
}

ci() {
  # The release decision's own logic — the one part of the release flow with something to test. It is
  # reached from any pull request that touches the CI, so a release check can't break unnoticed
  # between releases.
  gate node --test .github/scripts/release.test.mjs
}

# Each area runs in a subshell: two of them `cd`, and `all` must not start the plugin's tests in the
# app's directory.
case "${1:-}" in
  app) (app) ;;
  plugin) (plugin) ;;
  website) (website) ;;
  ci) (ci) ;;
  all)
    (app)
    (plugin)
    (website)
    (ci)
    ;;
  *)
    echo "usage: checks.sh app|plugin|website|ci|all" >&2
    exit 2
    ;;
esac
