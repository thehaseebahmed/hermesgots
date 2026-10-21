# CI protects billing whether or not it is free today

**Supersedes ADR 0002.**

ADR 0002 tiered CI around a private repository's monthly allowance of GitHub-hosted minutes. The
repository is public now, and GitHub's standard hosted runners are free and unlimited on a public
repository, so the allowance no longer limits anything. This record does not take the habit away
with it. Free is a fact about the repository's visibility today and not something the project
controls: it can go private again, a job can ask for a larger runner (billed even on a public
repository), and a workflow written carelessly now is the one that spends the allowance later. So
**protecting billing is still the first constraint on CI**, ahead of convenience. What changes is that
a cost is no longer an emergency; it is a thing a new workflow has to answer for.

What that asks of a workflow, whatever it costs today:

- **Run only what the event can have changed.** A pull request runs the gates its diff touches, and
  every gate when the diff can't be worked out. This is ADR 0002's rule, kept for the same reason plus
  one: a plugin change doesn't wait on the app's build.
- **Filter inside the job, never with `paths:`** on a workflow a required check depends on, since a
  skipped workflow leaves its check pending and blocks the merge. `changed-areas.sh` still answers
  what moved.
- **Keep one owner for the check set** (`checks.sh`), so CI and the development image can't drift.
- **Scheduled work skips when nothing moved**, as the nightly e2e run does (ADR 0029).
- **Every job has a timeout and every workflow a concurrency group**, so a hang or a pile-up is cut
  off rather than billed. Artifacts are kept for days, not months.
- **Standard runners only.** A larger runner is a deliberate, argued exception.

ADR 0002 rejected a nightly full run, for its minutes and for its late feedback. The minutes are not
the objection now; the late feedback still is, and ADR 0029 accepts it for the e2e registry, which no
pull request runs.

## Considered options

- **Keep ADR 0002 as it is** — its title and argument are an allowance that no longer exists, so a
  reader would have to work out which parts still hold.
- **Declare CI unbudgeted and drop the diff gating** — free today, and one less script. Not chosen: it
  makes the first private day the day every pull request starts spending the allowance, and it makes
  every pull request wait for the slowest gate.

## Consequences

- ADR 0002 carries a line pointing here. ADRs 0003 and 0004 cite it for the diff gating and its
  mechanism; both stand.
- If the repository goes private, the nightly run needs a second look: every night it would cost
  about 1,100 minutes a month against a 2,000 or 3,000 allowance.
