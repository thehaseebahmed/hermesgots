#!/usr/bin/env bash
# What a Deploy run made, as the run's summary: the site the deploy went to, where to look at it, and
# for a candidate why publishing it by hand is not how production moves here.
#
#   usage: deploy-summary.sh candidate|production     (from the repository root, in a Deploy run)
#
# The site comes from the Netlify API rather than a URL variable, because the site's primary URL is a
# custom domain: no branch-deploy URL can be built from one, and the admin URL is only in the API. A
# site the API won't answer for costs the links, never the step — the run has already deployed by then.
set -euo pipefail

kind=${1:-}

{
  if [ "$kind" = production ]; then
    echo "### Published to production"
    echo
    echo "A production deploy: the one call Netlify meters, at 15 of the team's credits."
  else
    echo "### Nothing published — this is a candidate"
    echo
    echo "An unpublished Netlify branch deploy, aliased \`candidate\`: no credits, and neither the"
    echo "site's live version nor its published deploy moved."
  fi
  echo
  echo "From \`${GITHUB_REF_NAME:-?}\` at \`${GITHUB_SHA:0:7}\`."

  # getSite's answer carries the site's name (what a branch-deploy URL is built from), its URLs and
  # its admin URL. Anything unexpected there leaves the links out rather than printing a guess.
  site=$(npx --yes netlify-cli@27.12.0 api getSite \
    --data "{\"site_id\":\"${NETLIFY_SITE_ID:?}\"}" 2>/dev/null || true)
  read -r name url admin < <(printf '%s' "$site" | python3 -c '
import json, sys
try:
    site = json.load(sys.stdin)
except Exception:
    site = {}
print(site.get("name", ""), site.get("ssl_url") or site.get("url", ""), site.get("admin_url", ""))
')

  if [ -n "$name" ] && [ -n "$url" ] && [ -n "$admin" ]; then
    echo
    if [ "$kind" = production ]; then
      echo "- Live at ${url}"
    else
      echo "- Look at it: https://candidate--${name}.netlify.app"
    fi
    echo "- Deploys: ${admin%/}/deploys"
    if [ "$kind" != production ]; then
      echo
      echo "Publishing a candidate by hand is not how production moves here: a promoted branch deploy"
      echo "keeps its own URL, and Netlify Identity sends sign-in back to the URL of the deploy it"
      echo "serves, so promotion would leave production signed out. Run this workflow by hand with"
      echo "\`promote\` on instead, to publish a production deploy of the same tested build."
    fi
  else
    echo
    echo "The site's own URLs could not be read from the Netlify API, so this run doesn't link them."
  fi
} >> "${GITHUB_STEP_SUMMARY:?}"
