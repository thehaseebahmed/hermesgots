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
group() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "== $*"; fi
}
endgroup() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi
}

# Every gate's own log, so gates that run at the same time cannot interleave theirs: a `::group::`
# block holding another gate's output is unreadable, and the end of a failure's log is the part a
# reader needs. `mktemp`, never a path in the tree.
LOGS=$(mktemp -d)
trap 'rm -rf "$LOGS"' EXIT
GATE_NAMES=()
GATE_PIDS=()
DURATIONS=()

record() {
  DURATIONS+=("$1|$2")
}

# What each gate cost, in the order they were run, and on a runner the same table on the pull
# request's own summary. The chain's wall clock is no longer the sum of these, so this table is how a
# regression is read: the number that grew names the gate to look at. It is not a budget and nothing
# fails on it — a shared runner's variance is not a broken change.
report() {
  [ "${#DURATIONS[@]}" -gt 0 ] || return 0
  local entry
  {
    echo
    echo "gate | seconds"
    echo "--- | ---"
    for entry in "${DURATIONS[@]}"; do
      printf '%s | %s\n' "${entry%|*}" "${entry##*|}"
    done
  } > "$LOGS/report"
  cat "$LOGS/report"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "### ${AREA:-checks}"; cat "$LOGS/report"; } >> "$GITHUB_STEP_SUMMARY"
  fi
  DURATIONS=()
}

# One command, one group, its own duration. `|| status=$?` is load-bearing: a bare call under `set -e`
# exits mid-group, and the end of a failing gate's log is what a reader needs.
gate() {
  local started=$SECONDS status=0
  group "$@"
  "$@" || status=$?
  endgroup
  record "$*" "$((SECONDS - started))"
  return $status
}

# The same, but beside the other gates: it starts, writes its log and its duration, and `await_gates`
# replays all of them once every one has finished.
start_gate() {
  local name=$1
  shift
  [ "${1:-}" = "--" ] && shift
  GATE_NAMES+=("$name")
  (
    local started=$SECONDS status=0
    "$@" || status=$?
    echo "$((SECONDS - started))" > "$LOGS/$name.seconds"
    exit $status
  ) > "$LOGS/$name.log" 2>&1 &
  GATE_PIDS+=($!)
}

# Waits for every gate that was started, then replays each log in the order it was started, so one
# gate's failure is not hidden by another's success. Nothing returns early: every log is printed and
# every duration recorded before the area's exit code is decided.
await_gates() {
  local failed=0 index
  for index in "${!GATE_PIDS[@]}"; do
    wait "${GATE_PIDS[$index]}" || failed=1
  done
  for index in "${!GATE_NAMES[@]}"; do
    group "${GATE_NAMES[$index]}"
    cat "$LOGS/${GATE_NAMES[$index]}.log"
    endgroup
    record "${GATE_NAMES[$index]}" \
      "$(cat "$LOGS/${GATE_NAMES[$index]}.seconds" 2>/dev/null || echo '?')"
  done
  GATE_NAMES=()
  GATE_PIDS=()
  return $failed
}

app() {
  cd app
  # The install runs alone: it owns the package store every later gate links from, so nothing else can
  # start until it is done.
  gate pnpm install --frozen-lockfile

  # Then the gates that share nothing run together. They are independent by construction — lint reads
  # the source, `tsc -b` writes only its own build info, neither test tier writes anything, and the
  # build writes `dist/` — and one after another they were the job's whole wall clock. The two test
  # tiers leave a core free (`--test-concurrency` in the app's scripts): this is the work that uses it.
  #
  # Every `scripts/test-*.mjs` is a unit test and every `scripts/test-*.tsx` a component test, found by
  # name rather than listed here, so a new file is gated the day it lands. What a connection's plugin
  # answered is remembered for the page, so component files run in processes of their own and a test of
  # a host that answers differently takes a connection of its own (`connection` in the kit).
  # ADR 0019 keeps geometry out of these: no layout, so nothing here measures.
  start_gate lint -- pnpm lint
  start_gate typecheck -- pnpm typecheck
  start_gate unit -- pnpm test:unit
  start_gate component -- pnpm test:component
  start_gate build -- pnpm exec vite build
  await_gates

  # `pnpm build` is `pnpm typecheck && vite build`, and `typecheck` has run above: the tsconfigs emit
  # nothing, so a second pass would only check the same code again.
  #
  # Recharts belongs in the chart's own lazy chunk and never in the chat route's entry chunk, so this
  # assertion runs over the build above — unwired it could not have failed. It waits for the build,
  # because it reads what the build wrote.
  gate node scripts/check-openui-chunks.mjs
}

plugin() {
  # `cryptography` is the environment's to install: the workflow adds it, the image carries it.
  # `-t .` imports each test as `plugin.tests.*`, so the package's network guard loads first
  # whichever files run.
  gate python3 -m unittest discover -s plugin/tests -t .
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

# An area's durations are recorded in the subshell that ran it, so its report is printed there on the
# way out — including when a gate failed and `set -e` ended the area early, which is the run whose
# numbers a reader most wants.
area() {
  trap report EXIT
  "$@"
}

# Each area runs in a subshell: two of them `cd`, and `all` must not start the plugin's tests in the
# app's directory.
case "${1:-}" in
  app) (AREA=app; area app) ;;
  plugin) (AREA=plugin; area plugin) ;;
  website) (AREA=website; area website) ;;
  ci) (AREA=ci; area ci) ;;
  all)
    (AREA=app; area app)
    (AREA=plugin; area plugin)
    (AREA=website; area website)
    (AREA=ci; area ci)
    ;;
  *)
    echo "usage: checks.sh app|plugin|website|ci|all" >&2
    exit 2
    ;;
esac
