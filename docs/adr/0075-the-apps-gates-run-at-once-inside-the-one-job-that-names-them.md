# The app's gates run at once, inside the one job that names them

The **App gates** job ran its checks one after another: install, lint, `tsc -b`, the unit tier, the
component tier, the build, then the chunk assertion. Six gates in a line meant six waits — on a
4-vCPU runner it took over six minutes, and the only gate that was actually long was hidden behind
five that were short. A change to `.github/scripts/checks.sh` now runs the gates that share nothing at
the same time, and the chain's wall clock is the longest of them rather than their sum:

- the install still runs alone and first, because every later gate links what it links;
- lint, `tsc -b`, the two test tiers and the build start together — they are independent by
  construction: lint reads the source, `tsc -b` writes only its own build info, neither tier writes
  anything, and the build writes `dist/`;
- the chunk assertion waits for the build, because it reads what the build wrote;
- every gate keeps its own log, replayed in its own group once all of them have finished, so
  interleaved output cannot destroy a group or hide a failure's last lines;
- every gate's duration is printed as a table, and on a runner appended to the job summary.

The job keeps its name and stays one job. The name is the required check on `main`, matched by
string, so a second job would be a check nothing requires until someone edits branch protection by
hand — a faster job that no longer gates is not a faster gate.

Two things were cut from the long pole itself. The component tier loads a file's whole module graph
in a process of its own — 250 to 400 modules, of which the transform is about a tenth of a second and
the rest is the loader answering the same specifier once per importing module — so the loader now
answers each specifier once. And the tier names its worker count instead of taking the machine's:
`--test-concurrency=3` leaves one of the runner's four cores to the gates beside it, and
`--test-force-exit` ends each file at its summary rather than draining a jsdom realm that keeps the
event loop alive after the last assertion.

The job also stops reding pull requests it has nothing to do with. One component test,
`scripts/test-chat-next-older.tsx`'s *a thread left unfinished picks up where it stopped*, failed about
one run in four: measured at the base commit, 3 runs in 6, always the same way — `expected 100, actual
180`, every remaining page written by a device that had already closed. The paging loop refused a page
whose own run had ended, but a poll still in flight when the device closed started a run of its own,
and that run passed its own guard because it had just bumped the counter the guard reads. The page now
answers "is this run over" once, from the mount's abort signal, and that answer is read again where
each page is applied, so a closed device's page is dropped rather than written. The test waits for the
device's queue to drain instead of beating a fixed 50 ms window, and it still catches the defect: with
the fix reverted, the same 3 runs in 6 fail.

## Considered options

- **Split the chain into one job per gate** — the fastest win on paper, since the gates run on
  different runners rather than different cores. Rejected: each new job is a new check name that
  branch protection does not require, so the pull request would go green without them.
- **Run the component tier in one process (`--experimental-test-isolation=none`)** — it would remove
  108 boots. Rejected: what a connection's plugin answered is remembered for the page, which is why a
  file gets a process of its own and a test of a host that answers differently takes a connection of
  its own. Fewer processes would make that state shared between tests, and the failure would be a
  flake nobody could trace.
- **Cache the transform, or V8's compile cache** — the obvious answer for a per-file-process tier.
  Rejected on measurement: the transforms total about 100 ms across a file's whole graph, and
  `NODE_COMPILE_CACHE` moved a file from 7.4 s to 7.0 s. The cost is loading modules, not compiling
  them.
- **Node's in-thread `registerHooks` instead of the off-thread `register`** — it would remove a
  message port from every module's resolution. Rejected: the load hook needs a synchronous
  TypeScript transform and the installed toolchain has none, so hooks would stay split across two
  mechanisms for a cost that was not the bottleneck.
- **Drop the separate `vite build`** — rejected: the chunk assertion reads `dist/`, `dist/` is what a
  push uploads for the deploy, and `pnpm build` would only re-run the typecheck that just ran.
- **Fail the job when the chain exceeds a budget** — rejected: the number is for a reader, not a
  threshold. A shared runner's variance is not a broken change.

## Consequences

- **The wall clock is no longer the sum of the gates**, so the duration table is the record, and it is
  per gate rather than per job. A regression shows up as the number that grew.
- **A gate added to the parallel phase must not read another's output.** One that does belongs after
  `await_gates`, like the chunk assertion, and a gate that installs belongs before them.
- **The test tiers own their worker count.** Three leaves a core for the gates beside them on the
  runner; a machine with more cores is not used to that limit, which is the price of a number the
  image and the runner can both live with.
- **The dev image runs the same script**, so the phases reach it too: `all` runs each area in its own
  subshell and reports that area's durations before it ends, including when a gate failed.
