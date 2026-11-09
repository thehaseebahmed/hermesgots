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
| Unit tier (`scripts/test-*.mjs`) | new | G2 | a guard that reads every component test's assertions, both sides of each |
| Assert shim (`scripts/assert-hooks.cjs`, `scripts/assert-hooks-strict.cjs`) | new | G2 | `scripts/test-assert-shim.tsx` |
| Component loader (`scripts/component-loader.mjs`) | changed | G2 | the same file's two import spellings |

No flow crosses layers: every participant is the test tier, and no app layer changes.

## Steps
1. **The rooms test waits for the row it asserts.** The device's reading clears one commit before the
   sidebar redraws, so the test's last line asserted a screen that had not redrawn yet; it now waits for
   the mark's absence and keeps the device's reading as its own assertion. Goals: G1. After: none.
   Layers: component tests. Check: `test-rooms-list.tsx` beside two other files, eight runs — before, one
   run in three failed there (and one was SIGKILLed); after, 8/8 green, which is what this branch measured
   with the wait in place.
   Done.
2. **No test hands a found element to assert's equality.** A `missing()` helper in the harness — beside
   the pre-existing `absent()`, which answers a selector with the caller's message, and `absentText()`,
   which answers a control's words — answers presence with a boolean, and
   every equality assertion that hands it a found element becomes a check of that boolean;
   `assert.equal(element, null)` makes Node build a diff by inspecting the element, and the element
   carries React's fiber graph, so the diff walks the whole tree. The first pass swept the 80
   `find(...)`/`findAll(...)` sites; the spellings the widened guard knows swept 90 more. Goals: G2.
   After: 1. Layers: component harness, component tests. Check: a forced failure of a presence check
   prints its message and returns in milliseconds, where the element form climbs to ~5 GB and is
   SIGKILLed.
   Done.
3. **A guard keeps the pattern out of the spellings a test writes.** A unit test reads every
   `scripts/test-*.tsx` with the TypeScript parser and fails on an assertion that hands
   `equal`/`strictEqual`/`deepEqual`/`deepStrictEqual`/`notEqual`/`notDeepEqual` — on either side,
   since Node inspects both — a `find`/`findAll`/`findText`/`labelled`/`composerField`/`threadCard` or
   `document.querySelector*` call, or a local function that answers one, seen through a `??`/`||`/`&&`
   fallback. It is the style gate, not the guarantee: an element bound to a variable first, or one an
   imported helper answers, is outside what a file can be read for, and step 5 is what covers those.
   Goals: G2. After: 2. Layers: unit tier. Check: red on `9ab58e34`'s tests — 171 sites, 90 of them on
   the tree the first sweep left — and green after the sweep, with a fixture for each spelling and an
   unparsable file failing rather than skipped; reading the second argument and the fallbacks found
   `test-settings-chrome.tsx`'s `assert.equal(action.closest("header"), find("header"))`, which now
   asks `===` of the two.
   Done.
4. **A worker that grows the JS heap dies at 1.5 GB, naming itself.** The tier starts each file's
   process with `--max-old-space-size=1536`, about three times the largest worker measured at 570 MB,
   so a heap-shaped runaway fails as a red file instead of taking its neighbours with it. It does not
   bound the growth this plan is about — the inspect-shaped one lives outside V8's old space, and step
   5 is what bounds it (see Risks). Goals: G1 G2. After: 1.
   Layers: test tier. Check: a scratch file that allocates objects without bound dies at 1536 MB with
   `FATAL ERROR: Reached heap limit` naming itself, while the file beside it reports `ok`; the tier's
   own run peaks at 684 MB of cgroup memory.
   Done.
5. **The assert boundary scrubs an element before Node sees it.** `component-loader.mjs` maps
   `node:assert` and `node:assert/strict` to `scripts/assert-hooks.cjs`, which requires the real module
   (only an ESM import is intercepted) and wraps every assertion so an element argument becomes a short
   label — `[element <div data-band="rooms"> #7]`, the tag, up to two attributes and the node's own
   number, capped at 80 characters — and an array is scrubbed member by member; `assert-hooks-strict.cjs`
   is the same wrapper around the strict module, with its names written one per line so the named import
   resolves. Nothing else is touched: functions, promises, regexes and primitives pass through,
   `AssertionError` is not wrapped, and an element-free array keeps its identity so `strictEqual` still
   means identity. Goals: G2. After: 3. Layers: assert shim, component loader. Check: a red
   `assert.equal` on a mounted screen's nested element prints its own message and returns in 2 ms, where
   the same shape without the mapping is SIGKILLed with no message at all; `scripts/test-assert-shim.tsx`
   holds both import spellings, the label, the two nodes staying two nodes, and the assertions the shim
   must leave alone.
   Done.

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
- **A helper and a guard, not a one-line edit.** 90 sites the guard names (of the 171 it reads on
  `9ab58e34`'s tests, the rest answered by the first sweep) hand a found element to assert's equality;
  the next red one is the next 5 GB, so the pattern is swept and a unit test keeps it out.
- **Why 1536 MB.** The largest worker measured is 570 MB (bot-pane) and the tier's anonymous peak is
  660 MB; the cap bounds a runaway at roughly three times normal without touching a healthy run. What it
  does not bound was measured, not assumed: the inspect-shaped growth this plan is about lives outside
  V8's old space, and a probe that reproduces it was still SIGKILLed at the 5 GiB ceiling with the cap in
  place, while a probe that grows the JS heap died at 1536 MB with `FATAL ERROR: Reached heap limit`. The
  cap is containment for the second shape only; G1 and G2 are carried by the wait, the sweep and the
  assert boundary.
- **The assert boundary is the guarantee; the guard is the style gate.** The sweep and the guard both
  read a file, and 24 live sites were still there for the spellings a reader cannot see — an element
  reached as `thread?.querySelector('[role="img"]')`, a variable bound first, an imported helper — one
  of which the tier SIGKILLed at exactly 5368709120 bytes. The loader can see them all, because it sits
  where the specifier is resolved rather than where it is written: both assert spellings become the shim,
  and an element is `[element <span role="img" aria-label="Tri">]` before Node's inspect is reached.
  Measured on the live shape: without the mapping, `node --test` reports `signal: 'SIGKILL'` after 42 s
  and no message; with it, the same assertion prints "the row carries no icon" in 2 ms, with the worker's
  RSS flat at 345 MB. The guard stays as the style gate — the suite should read as though the shim were
  not there, and a future tier that loads no hooks would still be swept — but its claim is the shape of
  a test's own line, never the guarantee. What it cannot read: an element bound to a variable, an
  imported helper's answer, and `querySelector`/`closest` reached off an element rather than
  `document`.
- **A label carries the node's number.** The first shim named an element by its tag and attributes
  alone, and `test-switch-scroll.tsx`'s `assert.notStrictEqual(scroller, otherScroller)` — two regions
  that look alike and are not the same node — failed under it, which the tier's run caught. A label is
  `[element <div role="region" aria-label="Messages"> #12]`, with a number the node keeps in a
  `WeakMap` for the life of the process: two distinct nodes never compare equal, and one node always
  compares equal to itself, so identity assertions keep their verdict and only the diff changes.

## Risks
- The guard reads the expressions a test writes, so an element bound to a variable first
  (`const row = find(sel); assert.equal(row, null)`) or one an imported helper answers still slips past
  it. That is the shim's business, not the guard's: the failure still prints, it just reads as the label
  rather than as the test's own sentence. Every spelling the suite writes today is read.
- The shim changes what a test sees of an element: a failure's `actual` is the label, so a test that
  reads `error.actual` gets `[element <div …> #7]` rather than the node. Nothing in the suite does.
- A label's number is a per-process counter, so the same node reads `#7` in one run and `#9` in the
  next: a test may match the shape of a label, never the number.
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
