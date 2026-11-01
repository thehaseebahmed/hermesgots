#!/usr/bin/env bash
# Whether a scheduled sweep still has anything to do: main's head against the last green run of the
# same workflow. Answers `run=true|false` on stdout, for a step to append to `$GITHUB_OUTPUT`; what it
# decided and why goes to stderr, so the step's output file holds one line and nothing else.
#
#   usage: last-green.sh <workflow-file>        (in a step with GH_TOKEN set)
#
# Anything that isn't a schedule answers `run=true`: a pull request and a hand-run both asked for the
# work, and a workflow that can't read its own history is not a night to skip. Two workflows share this
# (`e2e-nightly.yml`, `dictation-bench.yml`) so the rule that decides "already passed" has one home.
set -euo pipefail

workflow=${1:-}
if [ -z "$workflow" ]; then
  echo "usage: last-green.sh <workflow-file>" >&2
  exit 2
fi

if [ "${GITHUB_EVENT_NAME:-}" != schedule ]; then
  echo "not a scheduled sweep, so it runs" >&2
  echo "run=true"
  exit 0
fi

last=$(gh run list --repo "${GITHUB_REPOSITORY:-}" --workflow "$workflow" --branch main \
  --status success --limit 1 --json headSha --jq '.[0].headSha // ""' || echo "")
if [ -n "$last" ] && [ "$last" = "${GITHUB_SHA:-}" ]; then
  echo "main is still $last, which the last green run of $workflow passed" >&2
  echo "run=false"
else
  echo "main has moved since the last green run of $workflow, or there isn't one" >&2
  echo "run=true"
fi
