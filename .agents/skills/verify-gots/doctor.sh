#!/usr/bin/env bash
# Doctor for a Gots verification instance: one read-only answer to "is this instance worth
# driving?". It checks the app and the mock Hermes servers the e2e CLI runs (ports 15173 and
# 18642-18645), who owns those processes, and whether the toolchain that drives them resolves.
# Exit 0 when the instance is worth driving, 1 when it is not. Nothing here writes.
set -u

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
app_dir="$repo/app"
APP_URL="${APP_URL:-http://127.0.0.1:15173}"
fail=0

command -v curl >/dev/null || { echo "FAIL toolchain curl is missing"; exit 1; }

hit() { # <label> <url> — a GET that must answer anything under 500, as the CLI's own probe reads it
  local code
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$2" || true)
  if [ -n "$code" ] && [ "$code" != "000" ] && [ "${code:-500}" -lt 500 ] 2>/dev/null; then
    echo "ok    $1 $2 (HTTP $code)"
  else
    echo "FAIL  $1 $2 (no answer${code:+, HTTP $code})"
    fail=1
  fi
}

echo "instance"
base=${E2E_MOCK_BASE:-18642}
hit app "$APP_URL/"
hit mock-live "http://localhost:$base/health"
hit mock-polling "http://localhost:$((base + 1))/health"
hit mock-legacy "http://localhost:$((base + 2))/health"
hit mock-no-dictation "http://localhost:$((base + 3))/health"

echo "processes"
# Pids by their short process name first: a cmdline pattern would match the wrapper shell this runs
# in, whose command line carries the pattern's own text.
node_pids() { # <cmdline substring> — node pids whose command line carries it
  local dir pid cmd
  for dir in /proc/[0-9]*; do
    [ "$(cat "$dir/comm" 2>/dev/null)" = node ] || continue
    pid=${dir#/proc/}
    cmd=$(tr '\0' ' ' < "$dir/cmdline" 2>/dev/null)
    case "$cmd" in *"$1"*) printf "%s %s\n" "$pid" "$cmd" ;; esac
  done
}
mocks=$(node_pids "mock-hermes.mjs")
if [ -n "$mocks" ]; then
  while read -r pid cmd; do
    echo "ok    mock pid $pid cwd $(readlink "/proc/$pid/cwd" 2>/dev/null || echo '?')"
  done <<<"$mocks"
else
  echo "FAIL  no mock-hermes process is up (pnpm e2e up starts one per mock)"
  fail=1
fi
vite=$(node_pids "vite")
if [ -n "$vite" ]; then
  while read -r pid cmd; do
    echo "ok    vite pid $pid cwd $(readlink "/proc/$pid/cwd" 2>/dev/null || echo '?')"
  done <<<"$vite"
else
  echo "note  no vite process (fine when --app points at an app started elsewhere)"
fi

echo "toolchain"
node -v 2>/dev/null | sed 's/^/ok    node /' || { echo "FAIL  node is missing"; fail=1; }
if [ -r /sys/fs/cgroup/pids.max ]; then
  max=$(cat /sys/fs/cgroup/pids.max)
  now=$(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo '?')
  budget="unlimited"
  [ "$max" != max ] && budget="$((max - ${now:-0})) of $max free"
  echo "note  threads: $budget in this cgroup — a parallel lane needs ~150 per concurrent browser"
fi
pw=""
if [ -n "${PLAYWRIGHT_MODULE:-}" ] && [ -f "$PLAYWRIGHT_MODULE" ]; then
  pw=$PLAYWRIGHT_MODULE
elif [ -f "$app_dir/node_modules/playwright/index.mjs" ]; then
  pw="$app_dir/node_modules/playwright/index.mjs"
else
  global=$(npm root -g 2>/dev/null || true)
  [ -n "$global" ] && [ -f "$global/playwright/index.mjs" ] && pw="$global/playwright/index.mjs"
fi
if [ -n "$pw" ]; then
  echo "ok    playwright $pw"
else
  echo "FAIL  playwright not found (app/node_modules, npm root -g, or PLAYWRIGHT_MODULE)"
  fail=1
fi
if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || [ -d "$HOME/.cache/ms-playwright" ]; then
  echo "ok    browsers ${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
else
  echo "note  no browsers path found; a local Playwright needs its Chromium installed"
fi

echo "run"
echo "      APP_URL=$APP_URL MOCK_URL=${MOCK_URL:-http://localhost:$base}"
echo "      artifacts ${GOTS_VERIFY_ARTIFACTS:-${TMPDIR:-/tmp}/gots-verify}"
echo "      build $(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo '?') app $(node -p "require('$app_dir/package.json').version" 2>/dev/null || echo '?')"
echo "      auth the mock takes its own fixed key; there is no credential to validate"

exit $fail
