# The whole e2e registry runs nightly, and a change runs only its own flows

The browser registry (`pnpm e2e all`, 64 flows and the polling reruns) takes about 37 minutes on one
machine, so asking every change to run all of it before it lands made the slowest gate the one
agents and contributors skipped, or waited out. A change now runs the flows it touches — the ones
covering the screens, routes and state its diff moves — and the whole registry runs once a night on
`main` (`.github/workflows/e2e-nightly.yml`), skipped when `main` is still the commit the last green
sweep passed. `pnpm e2e all` by hand is for when someone asks for it.

ADR 0002 rejected a nightly full set while the repository was private, and the reason was its
minutes. The repository is public now, and ADR 0030 retires that budget: standard GitHub-hosted
runners cost nothing on a public repository. ADR 0002's other objection still holds: a nightly
failure is read a merge after the change that caused it. That is the price, and it's paid only for
the flows a change didn't think it touched. The flows it did touch were run before it landed.

## Considered options

- **The registry on every pull request** — free now as well, and the feedback would sit on the
  change. Not chosen: 37 minutes on every push of every pull request, against a tier rule (ADR 0019)
  that already keeps most behaviour below the browser, would make the slowest check the one every
  merge waits on.
- **Sharding the nightly run across jobs** — the same work in a shorter wall clock. Not needed while
  nobody waits on the result; worth doing if it ever becomes a pull request check.

## Consequences

- A red nightly run is work for whoever merged since the last green one, and its screenshots and
  server logs are the run's artifact.
- The Playwright version is pinned in two places, the workflow and the development image's
  `Dockerfile`. Bump them together.
- If the repository goes private again, ADR 0030 reverses, and this run costs about 1,100 minutes a
  month if `main` moves every day.
