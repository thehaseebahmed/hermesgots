# The app is deployed from GitHub Actions, and published by hand

Netlify's own Git builds are off for the app's site, so this repo is its only builder. A merge to
`main` that touches `app/**` or `netlify.toml` starts `.github/workflows/deploy.yml`, which runs the
Tests workflow as its gate — the same diff-gated jobs a pull request runs, so an app-only merge runs
the app gates and nothing else — and then deploys an *unpublished* Netlify branch deploy, aliased
`candidate`, at `candidate--<site>.netlify.app`. Nothing publishes from a merge. Production moves only
when someone runs that workflow by hand on `main` with `promote` on — for a publish between releases —
or by cutting a release, which publishes what moved (ADR 0004): the same gate, and then a
production deploy of the same build. What is deployed either way is the `app/dist` the Tests app job
built and uploaded as an artifact, downloaded again in the deploying job rather than rebuilt, so what
ships is what was tested; the job still checks out and installs the app's dependencies because the
functions are bundled from source at deploy time.

The merge-time deploy is a branch deploy and not `--prod` because of how a credit-based Netlify plan
charges: a production deploy costs 15 credits, while branch deploys and Deploy Previews cost none. A
team out of credits is blocked from production deploys and nothing else — the API refuses the call with
`403 {"error":"Account credit usage exceeded…"}` before any file is uploaded, and netlify-cli shows
that as a bare `JSONHTTPError: Forbidden`, because it prints the body's `message` field while that
body carries its reason under `error`. So a merge costs nothing, every merge leaves a candidate to
look at, and the 15 credits are spent only when a person decides the app is worth publishing.

Two builders for one site would race, and on credit-based pricing a Netlify Git build of a merge is a
production deploy — 15 credits, and refused when the team is out — so the app's site keeps building
nothing on Netlify's side.

## Considered options

- **Publish with `--prod` on every merge** — what #241 merged. Rejected: 15 credits per merge, and that
  call is the one the account's credit block refuses.
- **Promote a candidate by hand from the Netlify UI**, which publishes an existing branch deploy and so
  creates no deploy and costs no credits. This was the decision here at first, and it is unsafe: a
  promoted branch deploy serves its own URL, so Netlify Identity sends sign-in back to that URL and
  production stays signed out (the mechanism is under the consequences). Rejected.
- **Keep a hand-run staging workflow alongside this one.** Rejected: `staging.yml` deployed the same
  shape this workflow now does — an unpublished deploy under an alias — so it was two workflows doing
  one thing. Its only unique capability was previewing an unmerged branch, which a per-PR deploy would
  bring back properly.
- **Trigger on `workflow_run` of Tests**, so the gate is GitHub's own. Rejected: `workflow_run`
  cannot carry a `paths:` filter, so deciding inside the job whether the merge was deployable means
  diffing a merge commit, which reads only the last commit of a multi-commit push.
- **Wait for the Tests run for the same commit by polling it with `gh`.** Rejected: reimplements the
  gate, and has to reason about a Tests run that its own `cancel-in-progress` had already cancelled.
- **Filter the deploy's own trigger by area in a job, not with `paths:`** — the mechanism ADR 0002
  chose for the gates, because a *workflow* skipped by `paths:` leaves a required check pending for a
  pull request. ADR 0002 keeps governing the gates; this branch adds a push-level `paths:` in one
  place and leaves the `pull_request` trigger without one, which is where the required checks are.
- **Rebuild in the deploy job** instead of deploying the tested artifact. Rejected: the same commit
  and lockfile rebuild to the same bytes in practice, but not by construction, and the artifact makes
  "what shipped is what passed" true rather than likely.
- **Deploy `app/dist` from the Tests workflow's own job.** Rejected: the gate and the deploy stay
  separate, so a test-only change never has to be reasoned about as a deploy.

## Consequences

- Production moves only when a person asks for it, through the one call that can publish: a hand-run of
  `deploy.yml` on `main` with `promote` on. Nothing on a merge, and nothing scheduled, publishes.
  Dispatching without `promote` runs the gates on a ref and publishes nothing, which is how the suite
  gets re-run.
- **Netlify Identity's `site_url` follows the deploy it serves** — not the host that was asked, and not
  a site-wide setting. Decoding the `state` JWT that `/.netlify/identity/authorize?provider=github`
  mints: on the production deploy, which `memento.thehaseebahmed.com` and `hermesgots.netlify.app`
  both serve, `site_url` is `https://memento.thehaseebahmed.com`; on the `staging--` branch deploy it
  is `https://staging--hermesgots.netlify.app`, with the same site id answering both. Asking from the
  production host while it served a *promoted* branch deploy gave that branch host, which rules out the
  request host, and two answers under one site id rule out a site-wide setting. So a promoted branch
  deploy can never return sign-in to production — and sign-in is compulsory in this app — which is why
  publishing goes through a production deploy instead. A rollback is unaffected: an older production
  deploy's URL is the site's own.
- The promote job costs 15 credits per publish and, while the team's credits are exhausted, is refused:
  production cannot be updated at all until the block clears, by a plan change or the next billing
  cycle. That block is what the candidate exists to work around; this change does not introduce it.
- The alias holds the newest merge's deploy — Netlify keeps the most recent successful branch deploy
  per branch, and a CLI alias is recorded as a branch of that name — so there is one candidate, not a
  queue. After a bad publish, rollback therefore goes to the previously published production deploy,
  which is retained, not to an earlier candidate.
- Netlify's side of this is set up by hand and cannot be checked from the repo: the app site's Git
  builds have to be stopped. Nothing is locked. A deploy lock on the production context would refuse
  the very deploy this design publishes with, so the deliberate hand-run is the guarantee instead.
- Tester builds of the Android app sign in and sync through the candidate (`MEMENTO_CANDIDATE_URL` in
  `android.yml`), so testers exercise the newest merge; the release build points at production
  (`MEMENTO_SITE_URL` in `android-release.yml`). The candidate URL is a variable of its own because
  `candidate--` only resolves on the site's netlify.app host, and the site's primary URL is a custom
  domain that no branch-deploy URL can be built from.
- Netlify's per-PR deploy previews for the app are gone with its builds, and no hand-run workflow
  replaces them any more: an app's previews are its merges. A per-PR alias deploy is a free one —
  branch deploys cost no credits — and is the change that brings them back.
- Each run's summary says what it made — the candidate URL and the site's deploys page for a merge, the
  live URL for a publish — read from the Netlify API (`getSite`) rather than assembled from a URL
  variable, since the admin URL is only in the API and the site's primary URL is a custom domain. A
  site the API won't answer for costs the run its links, never the deploy.
- The website build is not part of a deploy's gate, and was not before this: since ADR 0002 it belongs
  to pull requests alone, because Netlify builds that site on a merge.
- The suite is split across two triggers rather than removed. `tests.yml`'s own push trigger covers
  `plugin/**`, `website/**` and any `.github/**` change except `deploy.yml` — a CI change answers
  every area, so leaving it on this side is what still runs the app gates for one on `main` — and the
  Deploy workflow calls the same suite for `app/**` and `netlify.toml`. A push touching both sides
  runs each gate twice, each run in its own concurrency group (`concurrency_suffix` in `tests.yml`).
- On an app-only merge the app gates are reported by the Deploy run's call rather than by a Tests run
  of their own, so a required check configured against the standalone run's name has to be checked
  when this first lands.
