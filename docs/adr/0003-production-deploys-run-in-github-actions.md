# Production deploys run in GitHub Actions, not Netlify's Git integration

Netlify's own Git builds are off for the app's site. A merge to `main` that touches `app/**` or
`netlify.toml` starts `.github/workflows/deploy.yml`, which runs the Tests workflow as its gate — the
same diff-gated jobs a pull request runs, so an app-only merge runs the app gates and nothing else —
and then publishes with `netlify deploy --prod` against the same site staging deploys to, where
staging is an unpublished alias. What goes live is the `app/dist` the Tests app job built and
uploaded as an artifact, downloaded again in the deploy job rather than rebuilt, so the published
bytes are the tested bytes. The deploy job still checks out and installs the app's dependencies
because the functions are bundled from source at deploy time. Two builders for one site would race —
Netlify's build and this one both writing the site's deploy list, whichever finished last winning,
and a Netlify-side build of an older commit could quietly take production back — and the deploy also
has to come *after* the suite passes, which Netlify's build has no way to know.

Staging is deliberately not part of this: `staging.yml` stays hand-run on any branch.

## Considered options

- **Trigger on `workflow_run` of Tests**, so the gate is GitHub's own. Rejected: `workflow_run`
  cannot carry a `paths:` filter, so deciding inside the job whether the merge was deployable means
  diffing a merge commit, which reads only the last commit of a multi-commit push.
- **Wait for the Tests run for the same commit by polling it with `gh`.** Rejected: reimplements the
  gate, and has to reason about a Tests run that its own `cancel-in-progress` had already cancelled.
- **Filter the deploy's own trigger by area in a job, not with `paths:`** — the mechanism ADR 0002
  chose for the gates, because a *workflow* skipped by `paths:` leaves a required check pending for a
  pull request. ADR 0002 keeps governing the gates; this branch adds a push-level `paths:` in one
  place and leaves the `pull_request` trigger without one, which is where the required checks are.
- **Let Netlify keep building and add the workflow anyway.** Rejected: the race above.
- **Rebuild in the deploy job** instead of shipping the tested artifact. Rejected: the same commit
  and lockfile rebuild to the same bytes in practice, but not by construction, and the artifact
  makes "what shipped is what passed" true rather than likely.
- **Deploy `app/dist` from the Tests workflow's own job.** Rejected: the gate and the publish stay
  separate, so a test-only change never has to be reasoned about as a deploy.

## Consequences

- Netlify's per-PR deploy previews for the app site are gone with its builds. Staging — hand-run,
  any branch, one site-wide alias — is the preview environment instead. A per-PR alias deploy would
  be a separate change.
- Stopping the site's Git builds is a manual Netlify setting (`Build & deploy` → stop builds); the
  repo cannot do it, and until it is off production has two builders.
- The website build is not part of a deploy's gate, and was not before this: since ADR 0002 it
  belongs to pull requests alone, because Netlify builds that site on a merge.
- The suite is split across two triggers rather than removed. `tests.yml`'s own push trigger covers
  `plugin/**`, `website/**` and any `.github/**` change except `deploy.yml` — a CI change answers
  every area, so leaving it on this side is what still runs the app gates for one on `main` — and the
  Deploy workflow calls the same suite for `app/**` and `netlify.toml`. A push touching both sides
  runs each gate twice, each run in its own concurrency group (`concurrency_suffix` in `tests.yml`).
- On an app-only merge the app gates are reported by the Deploy run's call rather than by a Tests run
  of their own, so a required check configured against the standalone run's name has to be checked
  when this first lands.
- There is no hand-started deploy or rollback: a `workflow_dispatch` was dropped. Recovering means
  re-running the failed Actions run, or `netlify rollback` against the site by hand.
