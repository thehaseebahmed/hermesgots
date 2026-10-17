# CI spends a private repository's minutes by tiering the events

Memento is a private repository, so every job on a GitHub-hosted runner is billed against its plan's
monthly allowance — 2,000 minutes on GitHub Free, 3,000 on Pro or Team — and nothing in the
repository measures what a run cost or warns when the allowance is nearly gone. The checks
themselves stay as they are: what changes is when they run. A pull request runs only the gates its
own diff can have touched, and every gate runs when the diff cannot be worked out, because a
detection that quietly gave up would report Success without the work behind it. So the filtering
lives *inside* the jobs: a `changes` job publishes what moved and each gate job is skipped by a
condition. That shape is load-bearing rather than incidental — a job skipped by a condition reports
Success, while a workflow skipped by `paths:` leaves its required check pending forever, and `main`
requires checks to pass. A push to `main` then keeps a reduced run: the plugin tests and the app
gates, when the diff touches them — the pull request already proved them on the merge commit — and
never the website build, which Netlify performs on the same merge. Unattended checks follow the same
reasoning and give up their frequency rather than a merge's check: the BenchLM id check is weekly.
The dev image runs the other way round, and is the one place where a *fuller* run is the point: it
verifies an image it built locally before publishing its tags, on every `main` run whatever
triggered the build, so that a dependency bump cannot put an unverified image under `latest`. A pull
request, which publishes nothing, runs those checks only when the image's own recipe moved
(`Dockerfile`, `.dockerignore` or the workflow): a lockfile change rebuilds the image without
changing what runs inside it, so there is nothing new to verify.

## Considered options

- **`paths:` and `paths-ignore:` on the workflows** — the obvious lever, and what the Android,
  dev-image, plugin-scan and prompts-doc workflows already use for their triggers. Rejected as the
  filtering mechanism for the gates: a skipped workflow leaves its required check in a pending state
  and blocks the merge, so the same trick that saves minutes on an unrequired workflow breaks the
  ones the branch protection waits on.
- **Making the repository public** — standard runners are free on public repositories, which removes
  the problem rather than managing it. Rejected because it publishes the whole product; the budget is
  cheaper than the disclosure.
- **Running the full set on a nightly schedule instead of per pull request** — rejected: it moves the
  feedback away from the change that caused it, and the result is read on a merge nobody is watching.
- **A self-hosted runner** — no minutes at all, and still the fallback if the tiering is not enough.
  Rejected for now: it needs a host that stays up and keeps its toolchain current, and the gates are
  not the bottleneck this budget is.

## Consequences

- **The diff is read in one place.** `.github/scripts/changed-areas.sh` answers what moved, in a
  fixed vocabulary — `app`, `plugin`, `website`, `native`, `image` — and each workflow maps that
  onto its own jobs. A gate whose paths fall outside those areas needs a case there, or it never
  runs: that failure is silent (a check that does not run is not a check that fails), so a new
  gate's first run has to be watched. A diff that cannot be worked out answers with every area, for
  the same reason.
- **The check set has one owner.** `.github/scripts/checks.sh` holds the app's gates, the plugin's
  tests and the website's build; `tests.yml` runs one area per job and the image's verification runs
  `all`. The two statements had already drifted by the time the image was written (its verification
  was missing a step the app's gates had grown), so a gate added to the script now reaches both. The
  cost is that the script has to work in both places: it calls the tools their environment supplies
  and installs nothing but the dependencies an area installs for itself.
- The jobs keep the names `main`'s required checks were configured with. Renaming a job or a
  workflow means updating those settings in the same change, or pull requests hang on a check that
  will never report.
- Each gate still installs its own dependencies; the pnpm store cache is what keeps that from being
  the price of entry on every run.
- The estimates this was decided on are arithmetic, not measurements. The allowance page at the end
  of a billing cycle is the only place the tiering can be shown to have worked.
