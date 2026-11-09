#!/usr/bin/env bash
# Whether an image in the GitHub Container Registry can be pulled by someone who is not logged in.
#
#   usage: ghcr-public.sh <image>[:<tag>] [<tag>]
#   e.g.:  ghcr-public.sh ghcr.io/thehaseebahmed/gots-dev:latest
#
# The sandbox that runs Gots carries no registry credentials: a package left private is an image
# only its owner's machine can refresh, and the stale copy keeps answering instead.
#
# Exit 2 for a ref that is not a ghcr.io one or no ref at all; a refused token, a non-200 manifest
# and an unreachable registry all exit 1, each naming the settings page where visibility is changed.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: ghcr-public.sh <image>[:<tag>] [<tag>]" >&2
  exit 2
fi
ref=$1
case "$ref" in
  ghcr.io/*) ;;
  *)
    echo "ghcr-public.sh: only ghcr.io refs are supported, got $ref" >&2
    exit 2
    ;;
esac

repo=${ref#ghcr.io/}
repo=${repo%%:*}
tag=${2:-}
if [ -z "$tag" ]; then
  case "$ref" in
    *:*) tag=${ref##*:} ;;
    *) tag=latest ;;
  esac
fi

owner=${repo%%/*}
name=${repo##*/}
settings="https://github.com/users/${owner}/packages/container/${name}/settings"
subject="ghcr.io/${repo}:${tag}"

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

refused() {
  printf '%s is not publicly pullable: %s\n' "$subject" "$1" >&2
  printf 'Nobody without this account can pull it. Make the package public:\n  %s\n' "$settings" >&2
  exit 1
}

token_status=$(curl -sS --max-time 30 -o "$temporary/token" -w '%{http_code}' \
  "https://ghcr.io/token?scope=repository:${repo}:pull") \
  || refused "the registry could not be asked for a token"
[ "$token_status" = 200 ] || refused "the anonymous token was refused (${token_status})"
token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$temporary/token")
[ -n "$token" ] || refused "the token answer carried none"

# One Accept header, comma-separated: ghcr.io honours one, so the four types split across four `-H`
# lines made this image's OCI manifest answer 404 with `MANIFEST_UNKNOWN`, while the one list answers
# 200. Measured both ways on ghcr.io/thehaseebahmed/gots-dev:latest.
status=$(curl -sS --max-time 30 -o "$temporary/manifest" -D "$temporary/headers" \
  -w '%{http_code}' \
  -H "Authorization: Bearer $token" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${repo}/manifests/${tag}") || refused "the registry could not be asked for the manifest"

case "$status" in
  200) ;;
  404) refused "the manifest answered 404 — the package is private, or nothing is published under that name" ;;
  *) refused "the manifest answered ${status}" ;;
esac

digest=$(sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$temporary/headers" | head -1)
printf '%s is publicly pullable (%s)\n' "$subject" "${digest:-no digest given}"
