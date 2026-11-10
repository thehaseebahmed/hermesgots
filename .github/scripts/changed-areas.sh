#!/usr/bin/env bash
# Which areas of the repository a diff touched, one per line, for the workflows that gate on them.
#
#   usage: changed-areas.sh <base> [<head>]
#
# The vocabulary is fixed — `app`, `plugin`, `website`, `native`, `image`, `ci` — and the answer comes
# from the paths alone, so each workflow maps it onto its own jobs (the app gates take `app`, the
# APK build takes `native`, the development image's verification takes `image`, a workflow or one of
# the scripts the workflows call takes `ci`). Every area is printed when the diff cannot be worked
# out: a gate that silently never runs is worse than one that runs for nothing.
set -euo pipefail

base=${1:-}
head=${2:-HEAD}

changed=""
if [ -n "$base" ] && git rev-parse --verify --quiet "$base^{commit}" > /dev/null 2>&1; then
  changed=$(git diff --name-only "$base" "$head" 2> /dev/null) || changed=""
fi

if [ -z "$changed" ]; then
  printf 'app\nplugin\nwebsite\nnative\nimage\nci\n'
  exit 0
fi

app=false plugin=false website=false native=false image=false ci=false
while IFS= read -r file; do
  case "$file" in
    # The native project and the config that feeds it: the app's TypeScript alone is not a reason to
    # package an APK.
    app/android/* | app/capacitor.config.ts) native=true ;;
    app/*) app=true ;;
    plugin/*) plugin=true ;;
    website/*) website=true ;;
    # The app site's own build and deploy configuration: it changes how the app is published.
    netlify.toml) app=true ;;
    # The files the development image is built from: its own recipe, not the packages baked into it
    # (a lockfile change rebuilds the image but does not change what runs inside it).
    Dockerfile | .dockerignore) image=true ;;
    # The CI itself — a workflow or one of the scripts they share: run everything, so the change is
    # exercised by the pull request that makes it.
    .github/*) app=true plugin=true website=true native=true image=true ci=true ;;
  esac
done <<< "$changed"

if [ "$app" = true ]; then echo app; fi
if [ "$plugin" = true ]; then echo plugin; fi
if [ "$website" = true ]; then echo website; fi
if [ "$native" = true ]; then echo native; fi
if [ "$image" = true ]; then echo image; fi
if [ "$ci" = true ]; then echo ci; fi
