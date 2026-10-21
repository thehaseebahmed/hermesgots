# CI is not budgeted in minutes

**Supersedes ADR 0002.**

ADR 0002 shaped CI around a private repository's monthly allowance of GitHub-hosted minutes: 2,000
on Free, 3,000 on Pro or Team, and nothing in the repository to say when it ran out. The repository
is public now, and GitHub's standard hosted runners are free and unlimited on a public repository. So
the budget is gone, and minutes are no longer a reason for or against any check. A run's cost is
its wall clock: how long a pull request waits on it, and how long a contributor waits for the answer.

ADR 0002 decided several things on that budget, and each one is judged again here on what it
still buys without the budget:

- **A nightly full run is allowed.** ADR 0002 rejected one for its minutes and for its late
  feedback. Only the late feedback is left, and ADR 0029 accepts that for the e2e registry, which no
  pull request runs.
- **The gates stay diff-gated.** A pull request still runs only the gates its diff can have
  touched, and every gate when the diff can't be worked out. The reason is now its wait: a plugin
  change doesn't wait on the app's build, and a website change doesn't wait on the plugin's tests.
  That is a speed choice, not a budget one, so a gate that is cheap enough may run on every pull
  request without a case to argue.
- **The filtering stays inside the jobs.** A workflow skipped by `paths:` leaves its required check
  pending and blocks the merge. That was always the reason for the mechanism, and it has nothing to do
  with minutes. `.github/scripts/changed-areas.sh` still answers what moved.
- **The check set keeps one owner.** `.github/scripts/checks.sh` is shared by `tests.yml` and the
  development image so the two can't drift. That was a correctness reason, and it stands.
- **The BenchLM id check's frequency is open again.** ADR 0002 made it weekly to save minutes. It
  may run more often when there is a reason to; this ADR doesn't change it.

## Considered options

- **Keep ADR 0002 and amend it** — its title and its argument are the budget, so a reader would have
  to work out which parts still hold. A new record that names what survives, and why, is shorter to
  trust.
- **Drop the diff gating and run every gate on every pull request** — now free, and one less script
  to keep right. Not chosen: it makes every pull request wait for the slowest gate, and the
  every-area answer for an unknown diff already covers the case the gating could get wrong.

## Consequences

- ADR 0002 carries a line pointing here. ADRs 0003 and 0004 cite it for the diff gating and its
  mechanism; those parts stand, for the reasons above.
- **Larger runners are still billed**, even on a public repository. A job that wants one needs its
  own case.
- If the repository goes private again, this reverses: the allowance is back, and a scheduled run
  like ADR 0029's costs about 1,100 minutes a month when `main` moves every day.
