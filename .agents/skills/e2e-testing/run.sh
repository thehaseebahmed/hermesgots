#!/usr/bin/env bash
# Runs Memento's browser tests (app/scripts/regression-*.mjs and e2e-*.mjs) against the mock Hermes.
# Usage: .agents/skills/e2e-testing/run.sh [name-filter]   e.g. run.sh e2e-live
# Starts its own Vite (15173) and mocks (18642 with the change stream, 18643 without), and stops
# them when done. Screenshots go to $SHOTS_DIR (default: a temp folder, printed at the end).
set -uo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$root/app"
filter="${1:-}"
shots="${SHOTS_DIR:-$(mktemp -d)}"
logs="$(mktemp -d)"

if [ -z "${PLAYWRIGHT_MODULE:-}" ]; then
  for candidate in "$app/node_modules/playwright/index.mjs" "$(npm root -g)/playwright/index.mjs"; do
    [ -f "$candidate" ] && PLAYWRIGHT_MODULE="$candidate" && break
  done
fi
if [ -z "${PLAYWRIGHT_MODULE:-}" ]; then
  echo "Playwright not found: install it globally, or set PLAYWRIGHT_MODULE to its index.mjs" >&2
  exit 1
fi
export PLAYWRIGHT_MODULE SHOTS_DIR="$shots"

stop() { fuser -k 15173/tcp 18642/tcp 18643/tcp >/dev/null 2>&1 || true; }
trap stop EXIT
stop

cd "$app"
PORT=18642 node scripts/mock-hermes.mjs >"$logs/mock.log" 2>&1 &
disown
MOCK_NO_EVENTS=1 PORT=18643 node scripts/mock-hermes.mjs >"$logs/mock-polling.log" 2>&1 &
disown
pnpm exec vite --port 15173 --strictPort >"$logs/vite.log" 2>&1 &
disown
for url in http://localhost:18642/health http://localhost:18643/health http://localhost:15173; do
  if ! timeout 60 bash -c "until curl -sf $url >/dev/null; do sleep 0.5; done"; then
    echo "Server at $url didn't start; logs in $logs" >&2
    exit 1
  fi
done

failed=()
run() {
  local script="$1" mock="$2" label="$3"
  echo "== $label"
  APP_URL=http://localhost:15173 MOCK_URL="$mock" timeout 300 node "$script" || failed+=("$label")
}
for script in "$app"/scripts/regression-*.mjs "$app"/scripts/e2e-*.mjs; do
  name="$(basename "$script" .mjs)"
  [[ -n "$filter" && "$name" != *"$filter"* ]] && continue
  run "scripts/$name.mjs" http://localhost:18642 "$name"
  # The live-run tests also run where the app has to poll, as it does without the change stream.
  [[ "$name" == e2e-live* ]] && run "scripts/$name.mjs" http://localhost:18643 "$name (polling)"
done

echo
echo "Screenshots: $shots"
echo "Server logs: $logs"
if [ ${#failed[@]} -gt 0 ]; then
  printf 'FAILED: %s\n' "${failed[@]}"
  exit 1
fi
echo "All browser tests passed"
