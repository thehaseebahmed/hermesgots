# A red component test reports itself instead of killing the tier

## Goals
- **G1** The component test tier runs in the sandbox without `scripts/test-rooms-list.tsx` dying to the
  container's memory limit: the file passes beside the rest of the tier, as it does alone.
- **G2** A component test that fails says why, in its own message, and never takes the tier's memory with
  it — so a red run is readable instead of a list of files killed by SIGKILL.

## Non-goals
- Any change to the rooms feature: `src/` is not touched, and the row, its read and its mark stay as they are.
- The tier's worker count or wall clock: `--test-concurrency=2` stays; the tier measures 660 MB of
  anonymous memory of 5 GiB, so two workers are not what crosses the ceiling.
- The other intermittent files seen while hunting (`test-bubble-bot.tsx`, `test-bot-pane.tsx`,
  `test-chat-next-older.tsx`): each is a flake of its own and gets its own change.
- Raising the sandbox's memory limit: the ceiling is a fact of the box, and the tier has to live inside it.

## Change map
| Layer | Status | Goals | Tested at |
|---|---|---|---|
| Component harness (`scripts/component-kit.tsx`) | changed | G2 | a presence helper beside `find` |
| Component tests (`scripts/test-*.tsx`) | changed | G1 G2 | `scripts/test-rooms-list.tsx`'s "a room whose row moved is read again" and the sweep's own guard |
| Test tier (`app/package.json`) | changed | G1 | `pnpm test:component`'s own run |
| Unit tier (`scripts/test-*.mjs`) | new | G2 | a guard that reads every component test's assertions |

No flow crosses layers: every participant is the test tier, and no app layer changes.

## Steps
1. **The rooms test waits for the row it asserts.** The device's reading clears one commit before the
   sidebar redraws, so the test's last line asserted a screen that had not redrawn yet; it now waits for
   the mark's absence and keeps the device's reading as its own assertion. Goals: G1. After: none.
   Layers: component tests. Check: `test-rooms-list.tsx` beside two other files, eight runs — before, one
   run in three failed there (and one was SIGKILLed); after, 8/8 green, which is what this branch measured
   with the wait in place.
   Done.
2. **No test hands a found element to assert's equality.** A `absent()` / `shown()` pair in the harness
   answers presence with a boolean, and every `assert.equal(find(...), …)` becomes a check of that
   boolean; `assert.equal(element, null)` makes Node build a diff by inspecting the element, and the
   element carries React's fiber graph, so the diff walks the whole tree. Goals: G2. After: 1.
   Layers: component harness, component tests. Check: a forced failure of a presence check prints its
   message and returns in milliseconds, where the element form climbs to ~5 GB and is SIGKILLed.
   Done.
3. **A guard keeps the pattern out.** A unit test reads every `scripts/test-*.tsx` and fails on an
   assertion that passes `find(`/`findAll(` straight to `equal`/`strictEqual`/`deepEqual`. Goals: G2.
   After: 2. Layers: unit tier. Check: red on today's tree — 62 sites — and green after step 2, with a
   one-line fixture proving it catches a new one.
4. **One worker cannot eat the container.** The tier gives each file's process a heap cap
   (`--max-old-space-size=1536`, four times the largest worker measured at 570 MB), so a runaway dies
   naming its own file instead of the OOM killer taking its neighbours. Goals: G1 G2. After: 1.
   Layers: test tier. Check: a deliberate runaway in a scratch file dies with a heap error while the file
   beside it still reports green; the tier's own peak stays under 1 GB of anonymous memory.

## Decisions
- **Confirmed: the kill is a failing assertion's diff, not the app and not the concurrency.** Run
  (`bash .github/scripts/checks.sh app`, 5 GiB cgroup): `not ok 115 - scripts/test-rooms-list.tsx …
  signal: 'SIGKILL'`, with `memory.peak` at exactly `5368709120` and `oom_kill 3`. The worker that grew was
  `test-rooms-list.tsx` (5098 MB, measured per process). Paused through the inspector inside it, the stack
  was `strictEqual → innerFail → AssertionError → createErrDiff → inspectValue → formatProperty…` at the
  file's `assert.equal(find(…), null, "an answered room's row says nothing")`. The file alone reproduces
  it in-process, so contention is not required — only the failure is.
- **Refuted: the tier's two workers alone.** `pnpm test:component` on its own peaks at 909 MB of cgroup
  memory, 660 MB anonymous; the file alone sits near 500 MB.
- **Refuted: the build and typecheck beside the tier.** All gates at once peak at 2.7 GB of 5 GiB, and
  both finish (23 s and 15 s) long before the tier's 264th second, where the kill happened.
- **Refuted: a leak in the room's read path.** With the assertion waiting for the screen it asserts,
  the same file, beside the same two files, passed 8 runs in 8 — the growth is the error's formatting,
  which only happens when that assertion fails.
- **The wait, not just the device's reading.** The test asserted the sidebar after waiting on the
  database; the list redraws one commit later. Waiting for what the assertion reads is the fix the
  evidence supports, and it keeps the device's reading as its own assertion rather than dropping it.
- **A helper and a guard, not a one-line edit.** 62 sites hand a found element to assert's equality;
  the next red one is the next 5 GB, so the pattern is swept and a unit test keeps it out.
- **Why 1536 MB.** The largest worker measured is 570 MB (bot-pane) and the tier's anonymous peak is
  660 MB; the cap bounds a runaway at roughly three times normal without touching a healthy run.

## Risks
- The guard is a text match: an assertion written another way (`assert.strictEqual(value, null)` where
  `value` came from `find` earlier) slips past it. It catches the form the suite uses today.
- The heap cap turns a genuinely runaway test into a red file rather than a killed one; a test that
  legitimately needs more than 1.5 GB in one worker would now fail. None measured approach it.
- The rooms test may still fail for a real behavioural reason; after this change it fails honestly and
  quickly instead of dying, which is the point, but it does not make the room's row correct if it is not.

## Not now
- `test-bubble-bot.tsx`'s "a write that changes nothing the phone hears with is not sent" and
  `test-bot-pane.tsx`, each seen failing once under load, from the tier runs above.
- The component tier's 316-second wall clock, and whether `--test-concurrency=2` is the right number on a
  16-core box.
- Moving the room's needs-you read into the plugin, which the diff does not ask for.
