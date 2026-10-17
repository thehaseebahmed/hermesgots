# The app is deployed from GitHub Actions and promoted by hand

Netlify's own Git builds are off for the app's site, and its production publishing is locked. A merge
to `main` that touches `app/**` or `netlify.toml` starts `.github/workflows/deploy.yml`, which runs
the Tests workflow as its gate — the same diff-gated jobs a pull request runs, so an app-only merge
runs the app gates and nothing else — and then deploys an *unpublished* Netlify branch deploy, aliased
`candidate`, at `candidate--<site>.netlify.app`. Nothing publishes: production moves only when a
person picks a deploy and publishes it from the site's deploys page. What the alias carries is the
`app/dist` the Tests app job built and uploaded as an artifact, downloaded again in the deploy job
rather than rebuilt, so the candidate is the tested bytes. The deploy job still checks out and
installs the app's dependencies because the functions are bundled from source at deploy time.

The deploy is a branch deploy and not `--prod` because of how a credit-based Netlify plan charges: a
production deploy costs 15 credits, while branch deploys and Deploy Previews cost none. A team out of
credits is blocked from production deploys and nothing else — the API refuses the call with
`403 {"error":"Account credit usage exceeded…"}` before any file is uploaded, and netlify-cli shows
that as a bare `JSONHTTPError: Forbidden`, because it prints the body's `message` field while that
body carries its reason under `error`. Publishing an existing deploy, which is all promotion is,
creates no deploy at all — the same mechanism as a rollback, which Netlify documents as consuming no
credits. So a merge costs nothing and the choice to publish becomes a person's, taken when the app is
worth publishing.

Two builders for one site would still race, and on credit-based pricing a Netlify Git build of a
merge is a production deploy — 15 credits, and blocked when the team is out — so the app's site keeps
building nothing on Netlify's side.

## Considered options

- **Publish with `--prod` on every merge** — what this branch did before this ADR was rewritten.
  Rejected: 15 credits per merge, and that call is the one the account's credit block refuses.
- **Promote from a workflow job** — a `workflow_dispatch` running `--prod` against the site. Correct
  by construction, and the deploy's own URL would be production rather than an alias, but it pays 15
  credits per promotion, needs the credit block cleared, and adds a job for a decision a person is
  already making in the Netlify UI. Rejected for now; it is the fallback if promotion in the UI turns
  out to be unsafe (see the consequences).
- **Keep a hand-run staging workflow alongside this one.** Rejected: `staging.yml` deployed the same
  shape this workflow now does — an unpublished deploy under an alias — so it was two workflows doing
  one thing. Its only unique capability was previewing an unmerged branch, which a per-PR deploy
  would bring back properly.
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

- Production moves only when a person publishes it. Promotion is **Publish deploy** on any successful
  deploy in the site's deploys page, and it makes that deploy the live version without creating a new
  one; a rollback is the same action on an older deploy. Nothing in this repo can publish or roll
  back, so a stuck production is a person's problem, not a job's.
- The alias holds the newest merge's deploy — Netlify keeps the most recent successful branch deploy
  per branch, and a CLI alias is recorded as a branch of that name — so there is one candidate, not a
  queue. After a bad promotion, rollback therefore goes to the previously published production
  deploy, which is retained, not to an earlier candidate.
- **Sign-in after a promotion is unresolved, and it is the reason to be careful with one.** Publishing
  a branch deploy promotes that deploy without changing its own URL, and Netlify Identity mints its
  OAuth `state` carrying a `site_url`: asked from `hermesgots.netlify.app` while that host served the
  promoted branch deploy, the state named `https://staging--hermesgots.netlify.app`, so GitHub sign-in
  returned to the branch host and the production origin stayed signed out — and sign-in is compulsory
  in this app. Either the site's Identity URL setting pins it, in which case pointing that setting at
  production makes promotion safe, or it follows the deploy, in which case promotion has to become a
  production deploy (the rejected option above, at 15 credits). Publishing a genuine production deploy
  once and re-decoding the authorize state separates the two cases. Until that is settled, a promoted
  branch deploy is not a usable production deploy.
- The Netlify side of this is set up by hand and cannot be checked from the repo: the site's Git
  builds have to be stopped, and production publishing locked (deploy locks, or auto publishing off)
  so that a stray `--prod` or a re-enabled Git build fails instead of publishing. Promoting an
  existing deploy still works while publishing is locked.
- Netlify's per-PR deploy previews for the app are gone with its builds, and no hand-run workflow
  replaces them any more: an app's previews are its merges. A per-PR alias deploy is a free one —
  branch deploys cost no credits — and is the change that brings them back.
- The run's job summary carries the candidate URL and the site's deploys page, both derived from
  `vars.MEMENTO_SITE_URL`; with that variable unset the run says so rather than printing a dead link.
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
