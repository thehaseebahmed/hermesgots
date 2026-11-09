#!/usr/bin/env bash
# Whether an image in the GitHub Container Registry can be pulled by someone who is not logged in.
#
#   usage: ghcr-public.sh <image>[:<tag>] [<tag>]
#   e.g.:  ghcr-public.sh ghcr.io/thehaseebahmed/gots-dev:latest
#
# The question is not whether the image exists but who can obtain it: the sandbox that runs Gots
# carries no registry credentials, so a package left private is an image only its owner's machine
# can refresh — and a stale copy keeps answering instead. An anonymous pull token is granted for a
# public package and refused for a private one, which is the whole test.
#
# Exit 0 when the token and the manifest both answer, 1 when either is refused (naming the settings
# page where visibility is changed), 2 on a usage error.
set -euo pipefail

ref=${1:?usage: ghcr-public.sh <image>[:<tag>] [<tag>]}
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

# A package's settings page is keyed by its own name, which is the last segment of the repository
# path; the registry path can be longer.
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

# One Accept header, comma-separated: ghcr.io reads a single header, and a repeated one makes an OCI
# index answer 404 with `MANIFEST_UNKNOWN` however many types the request lists.
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
