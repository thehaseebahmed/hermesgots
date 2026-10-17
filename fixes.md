# Deferred fixes from the simplify pass

A cleanup review of `fix(usage): read an older Hermes core without read_only` (four parallel
reviewers: reuse, quality, efficiency, altitude) turned up three changes worth making that are too
wide for a cleanup pass. They are recorded here instead of applied: each touches shared
infrastructure or a second module, so each is its own decision.

Everything else the review found is applied on this branch: the probe reuses core's own
`_accepts_keyword` where the host has it and falls back to the plugin's own, it is cached, the
version-skew rationale lives in one place, and the tests pin both core signatures, the fallback
probe, an unreadable signature and a `**kwargs` core.

## Risky

### 1. One compat helper for the three host-signature probes

`plugin/usage.py::_accepts_read_only` asks whether the host's `fetch_account_usage` takes a kwarg.
`plugin/delegation.py` already answers the same question twice: `_delegate` probes `delegate_task`
for `background`, and `run` filters its call kwargs by `inspect.signature(delegate).parameters`.
Three copies of "does this host name the newer kwarg" now live in two leaf modules, kept in step by
hand.

- Cost: a later fix (a `functools.partial`, a proxy, another `**kwargs` shape) lands in one copy and
  silently not the others, and the next version-dependent kwarg is another copy.
- Suggested fix: a `plugin/hostcompat.py` owning `accepts(func, name)` / `call_accepted(func, **kw)`,
  with all three sites moved onto it.
- Why it is risky: it pulls `plugin/delegation.py` and its tests into a usage cleanup, and the
  probes are not identical today (a predicate versus a call filter). The tree's own idiom is
  per-module feature detection (`callable()`/`getattr`/guarded imports across
  `plugin/__init__.py`, `clarify.py`, `theseus.py`) and Hermes core exposes no plugin-facing version
  to gate on, so the split is deliberate rather than accidental. The reviewers disagreed on
  now-versus-later; the two who read the surrounding code most closely said later.

### 2. The fail-open guard hides a core failure

`plugin/usage.py::fetch` wraps the core import and call in one `try` that returns `None` on any
exception, and `None` means "no data" to the app: the sheet shows nothing. It also conflates "core
raised" with "core has no fetcher for this provider", so a core that throws skips the
`ollama-cloud` balance read even though core owns no fetcher for it.

- Cost: diagnostic only — a shape or signature regression looks exactly like a provider Hermes does
  not track, and the app's only recovery is its 5-minute back-off, so the failure stays silent for
  the session.
- Suggested fix: keep the fail-open behaviour (a 500 makes the app read the plugin as missing, which
  is worse) but make it observable with a `logger.debug(..., exc_info=True)` in each `except`,
  matching `plugin/__init__.py`'s idiom; and, if the distinction is wanted, a sentinel for "core
  raised" so a plugin-owned provider still gets its own read.
- Why it is risky: low if only a log line is added, medium if the `except` is narrowed, since an
  unexpected exception type would then surface as a 500 the app reads as "no plugin". The lines are
  pre-existing (`git blame`: 33a3f392) and the reachable case is thin — a healthy core catches its
  own fetcher failures and returns `None` rather than raising.

### 3. "ollama-cloud" is a bare literal in two modules that must agree

`plugin/usage.py::fetch` dispatches on `provider == "ollama-cloud"` while `plugin/usage_ollama.py`
stamps `provider="ollama-cloud"` on the snapshot it returns. Nothing ties them together and no
constant exists, although `usage_ollama.py` already keeps `BALANCE_URL` and `TIMEOUT_S` at module
level, so the convention is right there.

- Cost: a rename in one module turns the fallback into "no windows" with a green test suite; the
  tests would have to be edited in five places to notice.
- Suggested fix: `PROVIDER = "ollama-cloud"` next to `BALANCE_URL`, used for the snapshot and
  compared against by `fetch` (`plugin/usage.py` already imports the module).
- Why it is risky: pre-existing, low value, and it touches a second module's surface for a rename
  that buys little today.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the three blocks the pull request.

---

# Deferred fixes from the simplify pass on the fallback models

A cleanup review of `fix(bots): grey out fallback models while a write is in flight` (the same four
parallel reviewers: reuse, quality, efficiency, altitude) turned up three changes worth making that
are either wider than this branch or belong to a second mechanism. They are recorded here instead
of applied: the branch closes the race window for the one screen that has this field, and the
durable version of each fix touches shared plumbing.

Everything else the review found is applied on this branch: the write carries its own timeout and
re-reads the host when it runs out, `saving` derives from the pending write the hook already held,
the rows' disabled rule lives in one local, the caller's duplicate `baseUrl` guard is gone, and the
flow counts the writes that reach the host rather than only reading how the rows look.

## Risky

### 1. Queue the fallback writes in the hook

The branch closes the window in one screen's UI: the rows, their remove and Add grey out while a
write is in flight, so a second pick can't start on top of the first. The lost update itself is
still there. `useFallbackModels::save` (`src/lib/fallbacks.ts`) posts the whole list computed from
`list` at call time and keeps a single `pending` slot whose `finally` clears on the first write to
settle, so two writes that overlap from two screens — a second device or tab on the same bot, or a
pick started before the rows greyed — still leave the slower answer able to put the older list back.

- Cost: the guarantee is per screen, not per host, and `saving` can read false while a later write
  is still in flight, so the UI's claim ("what the host is being told") is only true of this screen.
- Suggested fix: serialise in the hook — chain the writes the way `src/lib/dictation.ts` chains its
  saves (`session.saving = session.saving.then(...)`, line 201) or coalesce per key the way
  `src/lib/chat.ts` does with `syncingQueue` / `refreshQueue` (line 1337), so a write starts only
  once the one before it settled and the last list posted wins.
- Why it is risky: it is the shape of a shared write path, not of a field, and the branch agreed to
  leave the queue out. `useFallbackModels` has exactly one consumer (`model-picker.tsx`), so the
  disable and the queue are co-extensive today rather than layered, and the held-write flow would
  have to be reworked to assert the queue instead of the greying out.

### 2. The default model, one field up, races the same way

`DefaultModelSetting` writes through `setDefaultModel` → `setHostModel` (`src/lib/model-info.ts`,
line 27), a different helper from the fallbacks route, so nothing in this branch covers it. Its
button is disabled only for a missing model list (`disabled={!providers.length}`,
`model-picker.tsx:489`) and its "in flight" state is a local `saving` cleared by a 4s timer
(`SETTLE_MS`, lines 461 and 507) rather than by the write resolving, so picking, reopening the sheet
and picking again while the first POST is outstanding still sends two writes, older one landing last.

- Cost: the same lost update the branch fixed, one field up on the same screen — and three shapes
  for "a host write is in flight" now sit in one component (the hook's `saving`, this timer-cleared
  local, and `EnabledSetting`'s own boolean), so the next host-write field copies whichever it
  lands beside.
- Suggested fix: give this path the in-flight signal it lacks — the hook's `saving` shape, or one
  small "host write in flight" primitive both fields use — and disable the button while the write
  is outstanding, keeping the 4s `saving` for its own job (holding the pick on show until the host's
  answer is read back).
- Why it is risky: it changes a field this branch never touched. Its write is a single choice rather
  than a whole list, so the window is narrower and the loss smaller, and the affordance it would sit
  beside (the pick staying on show for 4s) was deliberate. Best done together with the queue above,
  not before it.

## Careful

### 3. The host model is remembered once per subscriber

`useModelInfo`'s promise is shared per connection key, but `rememberHostModel` is awaited inside
every subscriber's own `.then` (`src/lib/model-info.ts`, lines 88-91). The bot editor mounts two
subscribers for the same bot — `DefaultModelSetting` (`model-picker.tsx:474`) and
`FallbackModelsSetting` (line 528) — so one host answer does the profile read at
`model-info.ts:58` twice and, when the host's model moved, the `updateProfile` write at line 62
twice (both can see the old value and both write), each re-emitting the settings screen's live query.

- Cost: a duplicate IndexedDB read, a duplicate profile write and a duplicate live-query re-emit per
  host answer, on the app's heaviest settings form; `forget()` (line 17) re-runs every subscriber's
  effect, so each of those runs remembers again.
- Suggested fix: remember once per (connection key, profile id) — a `Map` of the last remembered
  model inside the hook, or awaiting the shared promise behind such a key — keeping the per-profile
  keying, since one host can serve several bots that each need their own `hostModel`.
- Why it is risky: pre-existing (the second subscriber is the fallbacks field's, from the feature
  this branch fixes), invisible except as extra writes, and it touches the cache every picker in the
  app reads, so it wants checking against the chat screen's model pill as well as this form.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the three blocks the pull request. One cosmetic side
effect of hiding the field when the host can't record fallbacks has no entry: the heading now
appears only once the plugin probe has answered, so the settings card grows a moment after it opens,
which only a skeleton would avoid.

---

# Deferred fixes from the simplify pass on the chat's retry and failed sends

A cleanup review of `feat(chat): retry missed questions and failed sends, and show errors plainly`
(four parallel reviewers: reuse, quality, efficiency, altitude) turned up eight changes worth making
that are too wide for a cleanup pass. They are recorded here instead of applied: each touches a
second module, a state the app shares with the host, or a surface that does not exist yet.

Everything else the review found is applied on this branch: the failed send's retry and drop reuse
`sendQueued`/`removeQueued` instead of copying their bodies, the queued and failed action rows share
one component, a clarify outcome's title and whether an answer was owed come from one table, the
send-failed outcome is returned by `runTurn` rather than parked on the turn, its host follow-ups are
skipped when nothing reached Hermes, the double no longer carries a flag it never sets and ends a
replayed failed run's stream, and an e2e helper stopped sharing a name with `lib.mjs`'s.

## Risky

### 1. A retry mints a new idempotency key

`app/src/lib/chat.ts:1038` keys the POST to `/v1/runs` off the reply row's id, which
`app/src/lib/hermes.ts:2098` documents as what makes a retried POST return the run it already
started; the plugin's queue keys its own re-dispatch off the queue item id for the same reason. A
failed send's Retry re-sends with a fresh reply id, so a send the host accepted whose answer was
lost (a dropped connection, a 5xx from a proxy after the run began) is started again. The catch-up
reconcile then only pairs local user rows with `status === "done"` (`app/src/lib/history.ts:699`),
so the row this branch leaves as `error` is never matched and the turn can be inserted beside it.

- Cost: duplicate agent work — tool calls, a pull request — and two user bubbles for one message
  after a catch-up, on exactly the flaky networks the state exists for.
- Suggested fix: key the POST off something stable for the message (`userMessage.id`, or an id kept
  on the row) so Hermes's own dedupe covers a retry; and in the reconcile, match a failed row by
  content and time and promote it — clear the failure, keep its id, attach its reply — instead of
  inserting the turn again.
- Why it is risky: it changes the request shape in `hermes.ts` and the reconcile in `history.ts`,
  two modules this branch does not otherwise touch, and the promotion is a focused change of its
  own. The flows cannot see it: `blockSends` aborts before the request leaves.

### 2. A failed send is a second "not sent" state

`status: "error"` on a user row, with its own control row (`message-item.tsx`'s `FailedActions`)
and no reason shown, sits beside the state the app already had: `status: "queued"` with
`queuePaused` and `statusText` (`app/src/lib/chat.ts:1300-1302`), whose `QueuedActions` row prints
the reason the new one drops. The host and another device know only the queued one.
`app/src/lib/threads.ts:103-104` reads a thread's failure from its newest assistant row, so a chat
whose only turn failed to send reads idle in that screen's sidebar.

- Cost: two states, two control rows and two reason treatments for one situation, kept in step by
  hand, and every later reader of a message's status has to learn the new one.
- Suggested fix: give "not sent yet" one home — mark the row queued and paused with the host's
  wording and make `sendNextQueued` (`chat.ts:1381`) skip a paused row, or add an explicit
  `MessageStatus` for it and move the message row, threads, history and chat onto it together.
- Why it is risky: `MessageStatus` is switched on in four modules, and the queued state carries
  host-side meaning (the plugin sends it) that a local failure must not claim before
  `sendNextQueued` learns to leave a paused row alone.

### 3. "It never reached Hermes" is inferred from an empty draft

`app/src/lib/chat.ts:753` decides it from `!draft.runId && !draft.content && !draft.tools.length`,
and `runId` is only ever set on the `/v1/runs` path (`chat.ts:1038`). On a host without runs, every
failure looks like one that never left the device: a chat-completion turn the host accepted and then
failed (a 5xx, a timeout after the POST) keeps its message retryable, drops the reply row
(`chat.ts:1050`) and can be sent a second time.

- Cost: a retry can put the same turn on the host twice, and the reason the host gave for the
  failure goes with the reply row.
- Suggested fix: decide it where the failure is known — a throw before the request can have been
  accepted (no API key, an attachment upload) or a fetch-level network error is "never left", while
  an HTTP answer from the host is a failed turn that keeps its row, as it did before this branch.
- Why it is risky: it splits the failure handling in `sendMessage` and changes what a host's 5xx
  leaves behind, on a path the flows only exercise one way (a blocked or refused request).

## Careful

### 4. A failed send writes the reply row it is about to delete

`chat.ts:1055` deletes the empty reply row in a transaction, but `turn.close()` (`chat.ts:205`) sets
`dirty = true` and flushes unconditionally, so the draft — status `error`, its tools — reaches Dexie
and wakes every live query over the chat a beat before it goes.

- Cost: one wasted write and one live-query wake per failed send and per retry of an unreachable
  host, on the path the write budget exists to protect (`pnpm e2e stream-writes`).
- Suggested fix: mark the doomed reply where the failure is known and let `close()` skip its last
  flush, awaiting the flush the delete needs.
- Why it is risky: it moves `openTurn`'s flush lifecycle, which every turn shares, to save one write
  on one path.

### 5. The reason a send failed is stored and never read

`chat.ts:1058` writes the host's wording into the message's `statusText`, and nothing reads a user
row's `statusText`: `FailedActions` shows none by design, and the reply row that used to carry it is
deleted.

- Cost: the one place the app kept the host's answer to "why didn't it go" — rate limit, offline, no
  API key — reaches nobody, while the queue's own row still shows its reason.
- Suggested fix: a chat-level error line near the composer, reading the field the message already
  holds — the design keeps a reason out of the message row and separate in the chat.
- Why it is risky: it is new UI in `routes/chat.tsx` rather than a cleanup, and `failed-send.mjs`
  asserts the reason is not repeated under the message, so the surface has to be its own line.

### 6. "Ask again" names no question

`app/src/components/chat/session-cards.tsx:216` sends a fixed sentence, while the card holds the
question it means (`asked[0].question`, rendered beside the button). Nothing checks that the agent
asked anything again.

- Cost: the button promises a particular question is asked again and cannot deliver that, and the
  transcript gains a message the user never typed.
- Suggested fix: carry the question into the retry (`Ask me again: <question>`), or have the plugin
  re-raise the pending question from the clarify id it stored — that route does not exist yet.
- Why it is risky: it changes copy the user chose and what the transcript shows, and the plugin
  route is a new feature rather than a cleanup.

### 7. The double's failed turn records nothing

`app/scripts/mock-hermes.mjs:653` returns before `record`, so the failed turn leaves no transcript
row, while the host persists a `failed_turn` row that `history.ts:315-317` maps.

- Cost: the reload and catch-up path for a bare error row — the case `bareError` exists for — is
  never exercised, so a change to that row's shape passes CI.
- Suggested fix: record the failed turn as the host does, and extend `plain-error.mjs` to reload and
  assert the row still reads as plain text with no bot beside it.
- Why it is risky: test-only, but the double then has to match the host's row shape, which is
  exactly what it simplified away.

### 8. Three flows keep their own copy of the same page-side helpers

`app/scripts/e2e/failed-send.mjs:42` sends a photo from the page the way `photo-progress.mjs` and
`image-viewer.mjs` already do; the row locator is written twice (`failed-send.mjs:62`,
`plain-error.mjs:12`); and the laptop/phone-dark pair is restated in each flow this branch adds,
though `cli.mjs` already owns the height convention.

- Cost: the next flow copies a fourth time, and a change to the app's module paths or to the
  message slot name breaks three files.
- Suggested fix: one `photo(...)`, `row(...)` and `LOOKS` in `lib.mjs`'s `helpers(page)`, with the
  three flows using them.
- Why it is risky: it edits two pre-existing flows for a test-only gain, and each has to be re-run
  at both widths to show the move changed nothing.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the eight blocks the pull request.

---

# Deferred: the duplicate turns the submission flow sees while a chat sits open

The browser flows were run over the goal work once it was rebased onto main. `pnpm e2e submission`
is red there, and red on main itself without any of this branch's commits, so the finding is
recorded here rather than fixed inside a goal reframe.

What the flow sees: one `POST /v1/runs` for two concurrent sends, as intended, but four assistant
rows in the chat where it expects one (`app/scripts/regression-submission.mjs:74`). While the chat
is open with a run live on the host, the app reads the host's transcript about once a second — seven
reads in six seconds in a probe — and each read appends the same turn again.

## Risky

### 1. The catch-up poll re-reads the transcript whenever the rows it just wrote change

`app/src/routes/chat.tsx:464-472` polls `reconcileHistory` and `reattachRun` at `CATCH_UP_MS`,
restarting on `[id, updatedAt, hostRuns, hostRuns && messages?.length]`; `usePoll` runs a restart
immediately, so every append re-reads. The read itself re-fetches the tail rather than stopping at
what the host already has: `app/src/lib/history.ts:671-684` takes `conversation.hermesTip` as its
short-circuit, and with no tip on a chat that has local rows it goes straight to `fetchTail`. The
host double makes that loop visible: `app/scripts/mock-hermes.mjs:2081-2087` answers the transcript
route from a canned script whose rows carry fresh ids per request, so `rowIdOf`
(`app/src/lib/history.ts:550`) can't recognise what it already has and the same turn lands twice,
then three times, then four.

- Cost: the flow guarding the concurrent-send fix is red on main, so the next change to the send
  path or to reconciliation cannot tell a regression from the noise; and a host that renumbers rows
  (or an app read that races a rewrite) can duplicate a turn in the thread the user reads.
- Suggested fix: stop the loop where it starts rather than at the ids. Record the tip the chat read
  to (`hermesTip`) whenever rows are written, so `reconcile` can answer "nothing newer" without
  fetching; and take the local row count out of the poll's dependencies, since the poll's own writes
  change it — `caughtUpWithin` (`app/src/lib/history.ts:494`) is the tree's existing idiom for
  "this chat was read recently". If the mock is to blame for the ids, give its transcripts stable
  ones, which is what the host does.
- Why it is risky: the loop spans three owners — the app's reconciliation, the poll's dependencies
  and the host double's ids — and the app-side fix touches timing code that also carries
  reattachment, catch-up and sync on one timer, so it wants the flows run at both widths with the
  request budget (`pnpm e2e idle-requests`) watched as well as `submission`.

---

Found while running the flows for the goal reframe's rebase onto main, on a detached checkout of
main alone. It predates that branch and is not caused by it.

---

# Deferred fixes from the simplify pass on the BenchLM matching and the overall scores

A cleanup review of `fix(chat): match BenchLM scores across tags and model suffixes` (the same four
parallel reviewers: reuse, quality, efficiency, altitude) turned up seven changes worth making that
are wider than this branch or belong to a second mechanism. They are recorded here instead of
applied: each touches a shared path, a second module, or a host surface this branch does not own.

Everything else the review found is applied on this branch: the check builds one score map from the
payload's own rows rather than a narrowed copy rebuilt per provider (so a row carrying only a slug or
a name scores there exactly as it does in the app), its unused import is gone, a candidate chain is
built once per id instead of once per lookup on the picker's search path, the picker reads the
rankings state once and computes a score only for the BenchLM sort, `isRankings` is module-private
again, the migrations are back in version order, and the nightly job reports a check that could not
read BenchLM or models.dev rather than failing to parse a report that was never written.

## Risky

### 1. The known-gaps file stands in for a matcher miss

`app/scripts/benchlm-known-gaps.json` lists `anthropic/claude-sonnet-4-5` and its dated form with a
reason that now says BenchLM ranks it overall (48.57, #107/950). Those two entries are only unmatched
because the deployed proxy still serves the coding surface; once the overall surface is live they
should match exactly. The file's stated job (`check-benchlm-matches.mjs:1-3`) is ids BenchLM has no
row for, so a matcher miss filed as a coverage gap silences the job over a real defect.

- Cost: the nightly job goes green over an id the matcher should reach, and the allowlist drifts from
  its purpose. It is the same class of mismatch the branch fixed in code for `gemma4` and filed as
  data here — two mechanisms for one problem, so the next reader cannot tell which to use.
- Suggested fix: re-derive the file against the overall surface once it deploys, drop entries that
  turn into matches, and fix the matcher (or the alias data below) for any that stay unmatched but
  plainly exist on the site. Reserve this file for ids with no row anywhere on BenchLM.
- Why it is risky: confirming the spelling needs the live overall payload, which does not exist until
  the proxy deploys — and dropping the entries before then turns the nightly job red for a reason
  that is not a defect in this branch.

### 2. Family spellings are code rather than data

`app/src/lib/model-match.ts:62` splices a per-family alias (`gemma4` → `gemma-4`) into a candidate
builder that otherwise derives every spelling from shape (`:` tag to dash, a date or
`-preview`/`-free` suffix stripped).

- Cost: every future glued-version family (a `gemma3`, a `qwen3`, a `llama3`) needs another branch
  and another test inside the matcher, so it accretes family knowledge instead of staying generic.
- Suggested fix: an alias map consumed by `benchCandidates` (`{ gemma4: "gemma-4" }`), so a new
  family is a data edit. Keep it in `model-match.ts`, which must stay import-free for the
  `--experimental-strip-types` tests.
- Why it is risky: a general "letters followed by a trailing version digit" rule would be broader
  than the evidence, and this branch measured its candidate chain against the real payload — a
  speculative widening would undo that. One entry does not yet justify the indirection.

## Careful

### 3. One models.dev URL, two literals

`app/scripts/check-benchlm-matches.mjs:15` declares `MODELS_DEV_URL` while
`app/src/lib/models.ts:9` already has `CATALOG_URL` for the same endpoint.

- Cost: if the catalog URL ever gains a version or moves host, the nightly job silently queries the
  dead one while the app queries the new one, and the drift shows up as every model reading
  unmatched.
- Suggested fix: hoist the literal into a dependency-free module both import — the scripts already
  follow this pattern by importing `src/lib/model-match.ts` — since the check cannot import
  `models.ts` (Dexie, React and the `@/` alias).
- Why it is risky: one URL that has never changed, and the fix adds a module for a single string.

### 4. The check's BenchLM host is hard-coded

`app/scripts/check-benchlm-matches.mjs:14` bakes in the deploy host, while the app derives the same
endpoint from its site URL (`app/src/lib/rankings.ts:8`, `app/src/lib/native.ts:66`).

- Cost: a site rename or a staging run leaves the nightly job hitting the old host, and it fails as a
  red "BenchLM unreachable" rather than anything that names the cause.
- Suggested fix: read the site URL the way the app and the Android workflows do (the repo's
  `MEMENTO_SITE_URL`/`VITE_SITE_URL`), falling back to the current host.
- Why it is risky: it needs the workflow to pass that variable through, for a host that has not
  changed, on a job whose failure mode is already visible.

### 5. The proxy's bare catch hides an upstream failure

`app/netlify/functions/benchlm.mts:60` catches everything and discards it, and with a stale cache
present the function still answers 200: a persistent auth or schema failure upstream is invisible,
and the app scores from old data indefinitely. Pre-existing (`git blame`: f9a4fa05) — this branch
changed only the surface it requests.

- Cost: diagnostic only, but it is the one place that would say why the scores stopped moving.
- Suggested fix: log the error and keep serving the stale payload (the current behaviour is right;
  it just says nothing).
- Why it is risky: low, and out of scope for a cleanup of the matching — the line predates the diff.

### 6. One tooltip root per capability per row

`app/src/components/chat/model-picker.tsx:351` mounts a Base UI `Tooltip` root for each capability a
model has, in a list that is not virtualised.

- Cost: a provider listing 100+ models mounts 200+ tooltip roots, all re-rendered while the search
  box is typed.
- Suggested fix: a single `Tooltip.Provider` or one shared popup, if the list is ever seen to jank.
- Why it is risky: mounting cost only, and unmeasured — the rows are small and the list is
  short in practice.

### 7. The issue step reads 30 issues to find one

`.github/workflows/benchlm-match.yml:50` lists open issues by label and matches the title in
JavaScript.

- Cost: a page of issues per nightly run for one lookup, and the update would miss the issue entirely
  if more than 30 labelled ones were ever open.
- Suggested fix: `search.issuesAndPullRequests` with `repo:… label:benchlm-match in:title`.
- Why it is risky: it swaps a call that cannot fail for one that can, to save a read nobody pays for.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the seven blocks the pull request. Two live checks the
branch still owes are not entries here: the overall surface needs Netlify to deploy before
`claude-sonnet-4-5` reaches its row (entry 1), and the Dexie v14 upgrade has not been exercised on a
device.

---

# Deferred fixes from the simplify pass on the pull_request tool

A cleanup review of `feat(hermes): give the agent a pull_request tool with actions and drafts` and
its three follow-up commits (four parallel reviewers: reuse, quality, efficiency, altitude) turned
up four findings. Two are recorded here instead of applied: each touches shared infrastructure or a
second module.

The fourth was the force guard: `_push` refreshed the very ref its `--force-with-lease` checked
against, so the guard could never refuse anything. That one is fixed on this branch, on the decision
that the lease is against a commit the session knew before now, and that a branch it has never
pushed or fetched is refused rather than overwritten blind. The same change removed the block's
`"couldn't find remote ref"` stderr match, since nothing fetches on the way to a push any more.

Everything else the review found is applied on this branch: the app's tool-label map keeps
`open_pull_request` beside `pull_request` (the plugin keeps the old name resolvable forever, and the
checked-in replay fixture still carries such a call); `handle()`'s unreachable `update` arm is gone
(`update()` raises its own 409); `update()` reads the pull request with `checks=False`, which drops
two GitHub reads whose result it never used; `github._pr_or_error` holds the one
"the pull request comes back or it's an error" tail both writes need; the `open_pull_request`
redirect stub no longer gates `pull_request`'s own registration or wiring; `handle()` passes the two
trailing booleans by keyword; and the mock's turn vocabulary and its live pull-request state match
the tool again (they are always drafts, so the `"open"` arm was unreachable).

## Careful

### 1. "Still live" is re-written at every call site that looks at a pull request

`("open", "draft")` is now spelled out in four places inside the tool's own path —
`plugin/ship.py::ship` (`existing["state"] in ("open", "draft")`), `plugin/ship.py::update`,
`plugin/ship.py::close`, and `plugin/github.py::_live` — and twice more outside it
(`plugin/alerts.py`, `plugin/merges.py`). `_live` handles the raw API row; every other copy tests a
normalized dict, so they cannot simply call it today.

- Cost: what counts as a live pull request can drift between six sites; the plugin adds a state or
  changes draft handling and one copy keeps the old rule.
- Suggested fix: a `github.is_live(pr)` over the normalized dict (with `_live` delegating to a shared
  `LIVE_STATES`), then move all six sites onto it.
- Why it is not applied here: it edits `alerts.py` and `merges.py`, which this change never touched,
  so it belongs in a pass that can test their own flows.

### 2. `force` is validated in the handler while the text fields validate themselves

`plugin/ship.py::handle` type-checks `force` and answers a JSON error, but `title`, `body` and
`commit_message` are checked inside `ship()`/`update()` by `_text()`, which raises `ValueError` for
the handler to catch. A `force: "yes"` therefore comes back through a different path from a
`title: 42`.

- Cost: two answers to "how does this tool reject bad input", and a later reader copies whichever
  they find first.
- Suggested fix: a `_bool()` beside `_text()`, with `ship()` doing the check, so every argument is
  refused the same way.
- Why it is not applied here: the handler-level check is defensible for an argument the schema
  declares a boolean (the schema is what the model sees), so this is a preference rather than a
  defect, and the reviewers were split on it.

---

Found while simplifying the pull_request tool's own four commits, on this branch.

---

# Deferred fixes from the simplify pass on the model row's facts line

A cleanup review of `feat(chat): show a model row's cost and capabilities as fixed slots` (the same
four parallel reviewers: reuse, quality, efficiency, altitude) turned up four changes worth making
that are either wider than this branch or a design decision the branch should not settle on its own.
They are recorded here instead of applied.

Everything else the review found is applied on this branch: the top cost band is the exported
`MAX_COST_TIER` rather than a second `COST_BANDS.length + 1`, and the band is read off the price the
price sort already needs, so a model's facts cost one walk fewer over models.dev and parse its prices
once; the pick that answers "does models.dev list it at all" lost its load-bearing `entry ?` guard,
because `matchIn` now asks a pick only about an entry that exists, which protects every pick that
follows; the row's dim has one owner (`DIM`) and its two capability marks come from one table that
derives each mark's label and dim in one place; the fixed line is written in reading order instead of
an array, a filter and an index-keyed join; the doc comment no longer shows a separator inside the
cost run that the code never renders; and the AGENTS.md sentence on the row's shape moved out of the
context-window paragraph into the picker's own. The one behaviour the review flagged — an unlisted
model losing its BenchLM score to the row's `—` — was fixed on top of that pass rather than recorded:
the row now reads its score with a dash where the rest would be, and `—` is left for a model that
neither source knows anything about.

## Risky

### 1. One catalog entry for all of a model's facts

`modelFacts` (`src/lib/models.ts`) answers five questions in four walks of models.dev — `listed`,
`context`, `vision`, `reasoning` and the price the band comes off — because `findIn` resolves each
field independently: the model's own provider first, then any provider, so a field the own entry
lacks can come from a different entry than a sibling field.

- Cost: a model whose provider id doesn't match models.dev's, or whose entry lacks a field, walks
  every provider once per field instead of once in total. The `factsCache` bounds that to one such
  walk per model per catalog version, so it is paid on a catalog refresh, not per render.
- Suggested fix: a `findIn` that returns the matched entry, with every fact read off that one object —
  and one pass answering `listed`, which today needs a walk of its own to say "any entry at all".
- Why it is risky: it changes which entry each fact is read from, so a row's score, cost, marks and
  window could move for exactly the models the fallthrough exists for. That is a behaviour change to
  the feature the previous two commits built, and it wants the e2e flows and a catalog of real ids to
  judge — which this cleanup pass does not have.

## Careful

### 2. A dim slot says nothing to a screen reader

A dimmed mark keeps the plain label (`Vision`) and the cost slots carry no text alternative at all, so
the one distinction the row was built to draw — supported, unsupported, not known — reaches assistive
tech as "Vision" on every listed model, and five dim dollars read as a price.

- Cost: the fixed-slot design is silently wrong for a screen-reader user on every model whose
  modalities models.dev doesn't state, and an unknown cost is announced as a real one.
- Suggested fix: carry the third state in the text (`Vision unknown`), and give the cost a text
  alternative (`role="img"` with an `aria-label`, since a bare span's `aria-label` is ignored) naming
  the band, or that it is unknown.
- Why it is risky: it changes the tooltip and the accessible name of a row on every surface that
  renders this picker, and the wording was chosen deliberately (unsupported reads "No vision", unknown
  reads the plain name), so it is a design decision rather than a fix.

### 3. "Unknown" reads permissive for image input and conservative for the mark

`imageInputOf` (`src/lib/models.ts`) answers `true`, `false` or `undefined`, and its two callers read
the unknown in opposite directions on purpose: the composer's attachment gating treats it as "yes,
allow images" (`profile.imageInput !== false`, in `routes/chat.tsx`, `routes/bot-threads.tsx` and
`routes/share.tsx`), while this row's mark treats it as "don't claim it" and dims.

- Cost: the intended reading of `undefined` can only be recovered by reading both call sites, and a
  reader of the mark cannot tell whether the dim is deliberate or an oversight.
- Suggested fix: record the split where the tri-state is defined (the comment on `imageInputOf`) or in
  AGENTS.md's image-input paragraph, rather than leaving each caller to imply it.
- Why it is risky: it documents a deliberate asymmetry rather than fixing anything, and a shared
  tri-state helper both callers consume would be a larger change that flattens two intents into one.

### 4. The em dash is a literal in three files

`modelDetail`'s `—` is the literal `chat/goal-wizard.tsx` and `chat/usage-sheet.tsx` each write their
own copy of, and `src/lib/format.ts` exports no placeholder constant to import instead.

- Cost: three copies of one typographic placeholder, with nothing tying them together.
- Suggested fix: one exported constant in `format.ts`, used by all three.
- Why it is risky: pre-existing — this branch only moved the dash from a `parts.length === 0` fallback
  onto the listed gate — and it edits two files the change never touches, for a rename's worth of
  value.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the four blocks the pull request. One check is not an entry
here because it does not need deferring: both builds were rendered and the sheet is byte-identical
(same screenshot hash of the sheet element at phone light and tablet dark), so the cleanup is
pixel-neutral. The browser flows that open this picker were skipped at the author's request, so no
flow asserts the row's shape.

---

# Deferred fixes from the simplify pass on the slash menu's skills

A cleanup review of `fix(chat): read the composer's slash menu skills from the Gots plugin` (the
same four parallel reviewers: reuse, quality, efficiency, altitude) turned up three changes worth
making that are either wider than this branch or belong to a second mechanism. They are recorded
here instead of applied.

Everything else the review found is applied on this branch: the duplicate `request_profile()` the
branch had added (the file already defined one, and the later binding won, so the new copy and its
comment were dead) is gone, `listSkills` carries the read timeout every other host read has, its
dead bare-array tolerance is dropped, the menu row is a grid instead of a magic `pl-7` offset, the
plugin docstring no longer claims parity with the dashboard's different listing, and the app gates
the request on the `skills` feature it already advertised.

## Risky

### 1. The profile's skill scan has no cache of its own

`plugin/skill_catalog.py::read` runs Hermes's scan inside `_profile_scope`, which holds the
process-wide skills lock for the whole scan. Hermes caches the result, but its cache key ignores the
skills directory, so two profiles alternating force a full re-scan each time; a reviewer measured
~936 ms cold for 66 skills and ~31 ms warm on this host, against 0.2 ms for a Hermes-side cache hit.
Two `/skills` requests for different profiles can never overlap — both want the same lock.

- Cost: the first menu open per profile per warm window pays a full scan, and a multiplexed host
  serialises them. At the app's call rate (once per page per bot, only when the menu opens) that is
  not a problem today; it is the shape that gets slow when more screens want the list.
- Suggested fix: a small per-profile TTL memo in `skill_catalog` (return the last list for ~30 s),
  keeping the scan in `asyncio.to_thread` as it is.
- Why it is risky: it adds plugin-side state and a staleness window to a route that is currently
  stateless, and the cost is unmeasured under a real multiplexed host — the numbers above come from
  one profile pair on one machine. A cache wants a test that pins both hit and expiry behaviour.

## Careful

### 2. `request_profile` swallows every failure as "the launch profile"

`plugin/__init__.py::request_profile` wraps the import and the contextvar read in one `try` that
returns `None` on any exception, and `None` means the launch profile to everything that calls it.
The branch now calls it from a second place (the skills route reads it for its scan).

- Cost: a Hermes that renames or moves the contextvar answers with another profile's skills instead
  of failing, and the log says nothing.
- Suggested fix: narrow to `except ImportError` (the only expected case) and `logger.debug(...,
  exc_info=True)` otherwise, matching the plugin's idiom elsewhere.
- Why it is risky: the lines are pre-existing (`git blame`: the queue feature) and the failure is
  thin — the import is the only thing that can realistically raise. Narrowing changes what a caller
  sees for an unexpected exception, and the app reads a 500 as "no plugin".

### 3. The menu's failure is silent by design, so a broken host looks like a plain one

`app/src/components/chat/slash-menu.tsx` renders no line when the load fails, as asked: a dropped
connection, a refused key, the plugin's own 501 ("this Hermes version can't list skills from here")
and a 500 all look the same as a bot that has no skills.

- Cost: the 501 is a real "your Hermes moved its internals, update the plugin" signal and it is
  discarded, and `SkillsState`'s `error` member is now unobservable from the menu.
- Suggested fix: if it is ever wanted back, the repo already has the distinction — `lacksRoute` +
  `cooldown` (`src/lib/todos.ts` shows the shape): a missing route (older plugin) stays silent and
  backs off, while a real failure keeps surfacing.
- Why it is risky: the user asked for exactly this silence, and the app now gates on the `skills`
  feature, so the missing-route case never asks at all. Re-adding a line would undo a decision, not
  fix a defect.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the three blocks the pull request.

---

# Deferred fixes from the simplify pass on the chat's model dividers

A cleanup review of `feat(chat): show a chat's model changes in its thread` and the three checkpoints
under it (four parallel reviewers: reuse, quality, efficiency, altitude) turned up three changes
worth making that are wider than a cleanup pass. They are recorded here instead of applied: one wants
a shared helper in front of three existing modules, one moves a field onto its own read, and one is a
sweep across three test files this branch never touches.

Everything else the review found is applied on this branch: the divider's placement imports the app's
own `sameModel` from `model-match.ts` instead of mirroring it (the comment claiming the mirror kept
the module node-safe was wrong — `allowImportingTsExtensions` is on, and the placement tests already
load `model-match.ts` for that same reason), the placement's helpers are module-private again and a
turn carries only the two fields it reads, the model in effect has one spelling in `chat.ts`, the
host's two spellings of one model compare through the shared matcher in `context.ts`, the host double
computes a turn's model and provider once instead of twice a block, the scroller item draws the
divider rather than `MessageItem` (which is back to main's shape: 120 of its 130 changed lines were
re-indentation), an unreadable model history answers `None` instead of an empty list so the app keeps
the dividers it has rather than clearing them, the module prunes hourly with a `KEEP_MS` of its own
rather than borrowing `context.py`'s, and the tests' temp Hermes home comes from `tests/_helpers.py`.

## Risky

### 1. The model history walks two session ids where the plugin walks lineage four times

`plugin/model_changes.py::read(path, session_id, also=None)` takes the resolved session and the id the
app asked with, and `/context` passes exactly those two. A chat compressed twice reads A, B, C: the
route resolves `asked_id` (A) to the live session (C), so the read covers C and A and never looks at B
— the middle session, whose rows are where a long chat's older dividers were recorded. The plugin
already owns the walk this needs (`delegation._lineage`, `push._lineage`, `sessions.record_for` and
`stream.chat_session` each climb `parent_session_id`), and this is a fifth, one-hop copy of it.

- Cost: a chat compressed more than once loses the dividers recorded under its middle sessions, while
  the same host answers for the sessions on either side of them; and the fifth copy is a fifth place
  a change to how Hermes names parents has to land.
- Suggested fix: one lineage helper over the store's `sessions` table, read by `model_changes.read`
  (every ancestor, not two ids), with the four callers above moved onto it where their own shape
  allows.
- Why it is risky: it rewrites `delegation.py` and `push.py`, which this branch never touches, and
  each of the four walks stops where it does for its own reason (delegation caps at the parent for the
  child list; `record_for` stops at the project session). It wants its own task, with the plugin suite
  and the flows run over it.

### 2. The host's model list is persisted inside the context read

`refreshContext` (`app/src/lib/context.ts`) reads `/context` and writes both `liveContext` and
`modelChanges`, and the `unsupported` cooldown it starts is keyed on the `context` feature — so a host
whose plugin has one of the two routes and not the other is either asked forever or never asked
again. Every sibling record a chat reads (todos, provider limits, the workspace, the pull requests)
has its own refresh and its own `lacksRoute` cooldown, and `AGENTS.md` names
`src/lib/model-changes.ts` as where a chat's model changes are read: that module never asks the host
anything today.

- Cost: a plugin that ships `/context` without `model_changes` (or the reverse) is read as missing
  entirely, and the next reader looking for where the dividers come from finds the module they are
  placed in rather than the one that fetches them.
- Suggested fix: its own refresh beside the others, run when the transcript moved as
  `useSessionFollowUps` does, with its own feature and cooldown in `freshness.ts`'s terms; or, if one
  request per turn is the decision, say so in `AGENTS.md` and move the compare-and-write out of
  `refreshContext` into `model-changes.ts`, so both sides of the contract live together.
- Why it is risky: it splits one request into two on the path every chat runs at the end of a turn,
  and the timings in `freshness.ts` are the repo's one place for them — a new read there wants the
  request budget (`pnpm e2e idle-requests`) watched as well as the flows.

## Careful

### 3. Seven more test set-ups hand-roll the temp Hermes home

`tests/_helpers.py::temp_hermes_home` now holds the throwaway home and the fake `hermes_constants`
patch this branch's test used to carry itself, but `test_library.py` has four more copies (its
set-ups at lines 31, 93, 239 and 302), `test_plan_mode.py` two (28 and 79) and `test_community.py` one
(21).

- Cost: eight copies of one fixture, so a change to how the plugin resolves its home — or to the
  module it imports it from — lands in one and silently not the others.
- Suggested fix: the same call in each set-up, `self.home = temp_hermes_home(self)`.
- Why it is risky: test-only and mechanical, but `test_plan_mode.py:79` re-patches `hermes_constants`
  mid-test with a fake of its own and `test_library.py:239` wants a `files/` root rather than the home,
  so every site has to be read before it moves — and three files this branch never touches is a wider
  pass than a cleanup should make.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the three blocks the pull request. Two findings are
deliberately not entries here, because they were measured and do not hold:

- **The divider map is recomputed on every streaming write.** Keying the memo on something cheaper
  than the thread was the review's largest efficiency item: `routes/chat.tsx` re-runs the placement
  whenever the live query hands back a new array, which is every `FLUSH_INTERVAL_MS` while a reply
  streams. Measured on the module itself, at 2,000 messages over 1,000 turns: 0.18 ms median per
  recompute, 0.05 ms at 200, so about 1.3 ms of main-thread work per second of streaming in the
  longest thread there is. A key built from the values placement reads costs about as much as the
  placement does, and the cheap structural keys have a hole in them (a row rewritten at the same
  length, which `history.ts`'s reconcile does write). The single-pass merge of the two per-turn scans
  was tried and measured inside the noise (min 0.164 → 0.155 ms), so it was dropped too.
- **`/context` reads its two tables one after the other.** They are independent, and `asyncio.gather`
  would halve the route's latency in relative terms — but the plugin calls no `gather` anywhere today,
  both reads are local sqlite opens, and the route runs at most once per turn, so the absolute saving
  is under a millisecond on a path nobody waits for.

---

# Deferred fixes from the simplify pass on the development container image

A cleanup review of the development container image — `Dockerfile`, `.dockerignore`,
`.github/workflows/dev-image.yml` and the README's "Development container" section — turned up four
changes worth making that are either wider than this branch or belong to another mechanism. They
are recorded here instead of applied: the image and its workflow are new and nothing is published
yet, so each of them decides how the image is distributed rather than how it is built.

Two of the four are applied since: the image is built and loaded, verified, and only then published
(`ci: verify the image before publishing it`), and the check set has one owner,
`.github/scripts/checks.sh`, which `tests.yml`'s jobs and the image's verification both run. The two
below are what remains.

Everything else the review found is applied on this branch: the lockfile fetch moved below the
browser layer it does not feed, only the headless Chromium shell is installed (393 MB no flow could
reach), the npm cache no longer ships and `python3-venv` is gone, `.dockerignore` ignores what
`.gitignore` ignores, the workflow rebuilds the image when the four files it is built from change,
the check set is stated once — its owner is `.github/scripts/checks.sh` now — the e2e recipe waits
for the server instead of sleeping five seconds, and the IPv4/`::1` trap now sits in
`.agents/skills/e2e-testing/` with the other harness traps.

## Risky

### 1. The toolchain versions have no single owner

Node 22 is pinned in `tests.yml` (three times: the app gates, the website build and the CI checks) and in `android.yml`, `android-release.yml` (twice), `deploy.yml` (twice) and `release.yml`; pnpm 10 in `tests.yml`,
`android.yml`, `android-release.yml` and `deploy.yml` through `pnpm/action-setup`;
netlify-cli 27.12.0 in `deploy.yml`; Playwright 1.63.0
only in the Dockerfile, where `app/scripts/e2e/cli.mjs` resolves it at run time and neither
`app/package.json` nor `website/package.json` carries a `packageManager` or an `engines` field. The
image's header comment now names the file each version comes from, but nothing makes those files
agree.

- Cost: a bump in any one place leaves the image behind while its own header claims the versions
  match CI's, and the image is the only artefact that records which Playwright the flows run
  against.
- Suggested fix: give each version one home the others derive from — `packageManager: "pnpm@10.x"`
  and `engines.node` in the manifests (which is the field the Dockerfile's corepack note needs),
  and `playwright` in `app`'s devDependencies so the image installs the browser from the lockfile
  the app resolves it from.
- Why it is risky: it edits both manifests, four workflows and the image, and moving Playwright into
  `app/node_modules` changes how the e2e CLI finds its module — that reaches the flows' own
  resolution rule, so it is a task of its own.

## Careful

### 2. No artefact owns the container invocation

The README spells out how to give the container the tree, where to mount it and which ports to
publish, and `dev-image.yml`'s verify step writes the same invocation again. The repo has no
`.devcontainer`, compose file, Makefile or task runner — AGENTS.md's Commands section describes a
host checkout only — so the image's contract (mount at `/workspace`, root-owned files, the app on
15173 and the mocks above it) exists only as prose in two files.

- Cost: every consumer re-derives the invocation, and the two copies differ already — the workflow
  adds `ASTRO_TELEMETRY_DISABLED=1`, which nothing tells a reader of the README's `docker run`
  example to set, and only the workflow knows the image must run the check set to be worth
  publishing.
- Suggested fix: a `.devcontainer/devcontainer.json` naming the image, the mount, the published
  ports and the check command, so tooling and humans read one definition; the README then explains
  only what is container-specific.
- Why it is risky: it introduces an artefact type the repo does not have and a second way to start
  the tree, which is a decision about the development environment rather than about this image.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt; the one
correctness bug it turned up — the workflow's `paths` filter not watching the files the image is
built from — is fixed on this branch rather than recorded here, and neither of the two below blocks
the pull request.

---

# Deferred fixes from the simplify pass on the drafts and modes sync

A cleanup review of `feat(chat): sync unsent drafts and picked modes through the plugin` and the fix
that followed it (four parallel reviewers: reuse, quality, efficiency, altitude) turned up five
findings. Two are recorded here instead of applied: one separates the sync's payload from its merge
base, the other changes what a plugin refusal costs. The three narrower ones are recorded for the
same reason — each decides a product question, a cadence or a list's membership, that a cleanup pass
has no business deciding.

Everything else the review found is applied on this branch: the session-mode push is one helper
(`workspace.ts::pushSessionMode`) that both the pick and the pull call, so a mode adopted from
another device actually reaches the plugin — the guard that skipped it compared against the value
the pull had just written, so the push was dead; the draft mirror's two branches are one; the pulled
draft key comes from `draftKey` rather than a second `c:` literal; the composer's live draft read is
`useDraftText` in `drafts.ts` rather than a second `useLiveQuery` over the same row; its adopt effect
names the state it reads and drops an `eslint-disable`; a record with no draft in it no longer pays
for the size check, and the encoder is built once; and a stale second JSDoc on `mergePluginChats`
is gone.

## Risky

### 1. The feature gate strips the draft from the merge base, not only from the payload

`sync.ts::localChats(profileId, drafts)` builds one document that is both the body POSTed to
`/chats` and the base whose `at` decides which side of the merge wins. `drafts` comes from
`hasPluginFeature(profile, "draft_text")`, which is false when the plugin is older *and* when its
`/info` read failed, so a transient failure sends a record that carries the row's `changedAt` and no
`draftText` — a newer record without the field, which is the shape the merge reads as "this draft was
cleared".

- Cost: a draft dies on the plugin and on every other device that pulls, on a probe failure the user
  never sees; the device that typed it still holds the text, but nothing pushes it again until that
  chat changes for another reason.
- Suggested fix: separate the two jobs — `mergeChatList` taking the payload and the merge base
  separately, so only the payload drops `draftText` — or remember the last feature answer and let an
  unconfirmed probe mean "don't merge against a copy without it" rather than "send one".
- Why it is risky: it changes `hermes.ts::mergeChatList`'s signature, a function every bot's sync
  goes through, and the recovery path (the row still holding the text, a later push restoring it)
  needs the flows run with the probe made to fail, which is not a state any flow can reach today.

### 2. An oversized record fails a whole bot's chat merge on the plugin's measure, not the app's

The app sizes a record with `TextEncoder` (UTF-8 bytes, `sync.ts::DRAFT_RECORD_CAP`); the plugin
measures `len(json.dumps(value))` with the default `ensure_ascii=True`, where one non-ASCII
character is six characters and an emoji twelve. Between the two sits a band — roughly 22 KB of
non-ASCII draft on a 64 KB cap — where the app believes the record fits and `chats._validate`
refuses it. The refusal is a 4xx for the whole `POST /chats`, so that bot's chat list stops syncing
until the text shrinks or is sent, not just the draft.

- Cost: the guard does not do what its comment claims, and the failure it exists to prevent arrives
  as a bot-wide sync stall over a draft nobody would call large.
- Suggested fix: measure on the plugin's own scale before comparing — escape non-ASCII the way
  `json.dumps` does, or budget a third of the cap — and let `chats._validate` drop an oversized field
  and answer 200 with what it dropped, so a refusal can never cost the whole merge.
- Why it is risky: the app-side half is small, but the plugin-side half changes what a refusal means
  for every record, and a draft of that size is a case no flow or test covers today.

## Careful

### 3. Typing a draft is a write to the chat list

`drafts.ts::flushDrafts` mirrors the typed text onto the conversation row every 400 ms of typing, so
a live query over `conversations` re-runs at that rate for as long as someone types, and the sync
pass it wakes runs 1.5 s later for the same reason. The write is what the feature needs — the row's
`changedAt` is the plugin's merge clock — so this is a cadence question, not an extra write.

- Cost: the app's busiest screen re-reads the chat list several times a second while the user types,
  on the path the write budget (`pnpm e2e stream-writes`, `idle-requests`) exists to protect.
- Suggested fix: mirror on the flush that ends a burst — the visibility/pagehide flush and a slower
  timer — keeping the per-keystroke path to `db.drafts`, which nothing else reads.
- Why it is risky: the approved plan named `updateConversation` as the mechanism, and the flows
  cannot see the difference between a draft syncing a second late and a keystroke early, so it wants
  the sync's own budget measured before and after.

### 4. Three copies of "this session has started", and the new field is not one of them

`code.ts:61`, `code.tsx:59` and `chat.tsx:540` each spell out the same predicate — `draftAt ||
updatedAt > createdAt` — while `plugin/cleanup.py:59` spares a chat that carries `draftAt` *or*
`draftText`. The app writes neither field, so a session whose only content is a draft synced from
another device is kept by the plugin's sweep and still reads as unstarted in Code.

- Cost: one rule in four places, and a session that exists on the plugin but nowhere in the app —
  exactly the state the draft sync creates, since a draft reaches a session that has never run.
- Suggested fix: one exported predicate over the row, `draftText` beside `draftAt` in it if a draft
  counts (stamping `draftAt` from the same write is the smaller version of the same thing).
- Why it is risky: list membership is a product decision — the plugin keeps such a session so its
  draft is not swept, which is not the same as the app offering it — and it moves rows in Code, which
  `code-sessions.mjs` asserts by position.

### 5. A pulled mode reaches the row unvalidated

`sync.ts::applyChats` writes `entry.value.mode` onto the conversation with the rest of the record
and the pull's `adoptSessionMode` no longer rewrites it; `db.ts::sessionMode` — which maps `theseus`
to `auto` and anything unknown to `accept_edits` — is applied when a mode is picked, not here.

- Cost: a plugin that answers with a mode this app does not know puts it on the row, where the mode
  control's label lookup (`MODE_LABELS`, `mode-menu.tsx:62`) has no entry for it.
- Suggested fix: validate where the record is applied — a `sessionMode` over the copied field, the
  way a mode is validated on its way out.
- Why it is risky: it is a second change inside the generic field-by-field copy every chat record
  takes, for a value the plugin only ever writes from this app's own vocabulary.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — entry 2 is the one genuine defect it turned up, and none of the five
blocks the pull request.

---

# Deferred fixes from the simplify pass on the account session

A cleanup review of `fix(sync): don't sign out when a refresh token was already spent` and its two
follow-ups (four parallel reviewers: reuse, quality, efficiency, altitude) turned up four findings.
One is recorded here instead of applied: it wants somewhere to keep the last account the app saw.

Everything else the review found is applied on this branch: the base64url decode is one import-free
`src/lib/base64url.ts` rather than a copy in `push.ts` and another in `identity-session.ts`; "Identity's
answer, else the stored token's owner" is one `identityUser()` instead of a silent copy in `onAppUrl`
and a logged copy in `loadNativeAccount`; the account a stored token proves is built once, in
`identity-session.ts::storedUser`, and read by both clients, so the browser's load no longer signs a
user out over a check it couldn't make; and the function's two `Sign in first` answers come from one
`signInFirst()`. The efficiency pass found nothing worth changing: the token store is re-read per call
on purpose (the re-read before believing a rejection is the branch's own policy), `getUser()` precedes
the Bearer call only when a cookie is present, where it makes no request at all, and `inFlight` is
cleared in a `.finally` so it retains no tokens.

## Risky

### 1. The fallback account is a stub, so an unverified load loses the avatar and the name

`native-account.ts:163::storedOwner` builds a `User` from the stored access token's claims alone
(`{ id, email, userMetadata: {}, appMetadata: {} }`), and `identityUser` (`native-account.ts:171`)
hands it to the app whenever Identity can't be asked — the path this branch added so a hiccup never
shows the sign-in gate. Every field those claims don't carry is missing from the account the app then
renders: `pictureUrl` is undefined, so the avatar blanks (`routes/settings.tsx:756`,
`components/account-settings.tsx:83`), and `name` is gone.

- Cost: a session that survives a hiccup survives in a visibly degraded form, and the degradation
  lasts as long as Identity is unreachable — a device that loads offline shows an account with no face
  and no name, which reads as a half-signed-in state rather than as a session that is intact.
- Suggested fix: keep the last full `User` beside the tokens — `currentUser()` has one whenever the
  app is online — and let `storedOwner()` return that, falling back to the claims stub only when
  nothing better was ever stored, so the fallback is the real account rather than a constructed one.
- Why it is risky: it changes what the session store holds, so it wants the same single-flight and
  re-read discipline the tokens have, plus a migration for a device whose store predates the field.
  The stub is also correct as far as it goes — the branch's decision was that a check which cannot be
  made must not end the session, not that the account has to render well on that path.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and the entry does not block the pull request. Two findings are
deliberately not entries, because neither has a fix the tree can hold today:

- **Identity's refusal statuses are read once per bundle.** `tradeOutcome` (`identity-session.ts:40`)
  and `bearerUser` (`netlify/lib/identity.ts:22`) each decide that 401 and 403 are Identity's own word,
  joined by a comment rather than an import. The app and the functions are separate bundles and nothing
  under `netlify/` imports from `src/` (checked), so a shared predicate has no home both can reach;
  what is duplicated is two lines in two runtimes.
- **A third base64url copy the shared module cannot reach.** `netlify/lib/fcm.ts:140` carries the
  encoder half of the pair `push.ts` used to hold, in the functions bundle, under the same boundary —
  so extracting `src/lib/base64url.ts` leaves that one where it is.
- **The browser's client destroys its own session on a failed check, and that one is upstream.**
  `@netlify/identity`'s `hydrateSession` (`dist/main.js:603-637`) reads the account on a page load and,
  on any failure, calls `deleteBrowserAuthCookies()` before returning null — so one transient failure
  during a load ends a session that was perfectly good, and `account.ts` can do nothing about it: the
  cookie is gone by the time the app can look, which is why the app reads the store *after* the call
  and signs the user out when it is empty (the credentials really are gone, and a silent GitHub
  re-sign-in is one tap). Telling a refused token from an unreachable service needs the library to
  stop collapsing the two.

---

# Deferred: the app-level calculations still to move to the plugin

`docs/adr/0005-calculations-belong-on-the-plugin.md` decides that a fact a bot's host could work out is
worked out on the host, and names the clusters to move. One of them landed with that decision: the todo
list's own progress and each item's depth, which the plugin states with the list
(`plugin/todos.py::progress_of` / `depth_of`, `GET sessions/{id}/todos`) and the app no longer works out
(`src/components/chat/todos.tsx`, `src/lib/todos.ts`). The four below are recorded rather than applied:
the first three each change a route, a capability gate and a stored shape, so each is its own decision, and
the app has to keep working against plugins already installed in the field. `migrations/` holds the work order for
each one — the contract, the steps, the pitfalls the first cluster taught and the definition of done —
and `migrations/index.md` names the order to do them in.

## Risky

### 1. The context window is still resolved in the app

`contextWindow` (`src/lib/context.ts:19`) picks between three sources: the window recorded on the profile
(`:25`, written per device by `syncContextWindow`, `src/lib/models.ts:269`), Hermes's own window for the
call that ran the session (`:27`) and models.dev's for the model the chat runs next (`:28`, through
`modelFacts`). The plugin already answers the middle one — `context.py` keeps `context_length` per session
and returns it with the model — so one chat can show the plugin's figure and, before that model's first
call, the catalogue's, disagreeing with a second device that has a different catalogue cache.

- Cost: the window a chat is measured against is a device-local answer for a fact the host holds, and a
  chat on a fresh catalogued device can show one before Hermes has run the model at all.
- Suggested fix: the plugin resolves the window (Hermes's own figure, and models.dev where the model has
  no call yet, fetched and cached on the host) and `GET sessions/{id}/context` returns it; the app drops
  `contextWindow`'s catalogue branch, the profile's `contextWindow` / `contextModel` fields and
  `syncContextWindow`'s lookup, keeping only what the route sent.
- Why it is risky: the plugin gains an outbound models.dev dependency and an ETag cache it has never had,
  with its own way of being unreachable. The app keeps its catalogue for the model picker's cost tiers and
  modalities, so this leaves two fetchers of the same public payload by design (ADR 0005) — and the
  catalogue is what a brand-new chat shows the window from today, so removing the app's branch changes
  what that chat shows.

### 2. Usage cost is still priced in the app

`src/lib/pricing.ts` holds a hand-maintained Claude price table and `estimateCost`, used for the project's
total and each session's share (`src/components/project-usage.tsx:81`, `:169`), with a `partial` marker for
usage no price covers. The plugin's usage route already reads Hermes's own figures per session and per
model (`plugin/projects.py:330`, `COALESCE(actual_cost_usd, estimated_cost_usd)`), so the same tokens can
carry Hermes's price where it has one and the app's table everywhere else.

- Cost: two prices for one figure. A session Hermes priced with its own list and one the app prices from a
  table checked by hand disagree on the same screen, and the table is only ever as new as its last edit.
- Suggested fix: delete the table and the `partial` marker, and let the plugin price — Hermes's own figure
  first, models.dev's prices multiplied by the token counts where Hermes has none — returning a cost per
  session and per project that the app formats and sorts on.
- Why it is risky: it applies a price where Hermes deliberately left none, and models.dev's prices are the
  provider list's own rather than what a given plan bills (the file's own comment on Bedrock and Vertex).
  Whether an available approximation beats no figure is the decision this entry waits on.

### 3. Tool results are still interpreted in the app

`src/lib/tools.ts` reads a call's JSON result whole or cut short (`Reader`, `:110`), decides why it failed
(`failureReason`, `:249`), reads its exit code (`:268`) and counts a todo call's tasks (`:63`).
`patchStats` (`src/lib/history.ts:133`) counts the lines a patch added and removed, and runs both while a
run streams (`src/lib/chat.ts:315`) and when a transcript row is imported (`src/lib/history.ts:305`), so
every device works out its own verdicts from whatever text it happens to hold.

- Cost: a verdict is read from the stream's 500-character preview on the device watching a run and from
  the whole transcript on one importing it later, so the same call can read differently between devices,
  and the plugin — which can see the full result for every call — is asked none of it.
- Suggested fix: a plugin route per session answering each call's verdict by `tool_call_id` (its envelope,
  why it failed, its exit code, the lines a patch moved and whether it created a file), read when an event
  says the session moved; the app's `Reader`, `failureReason`, `exitCode`, `taskCount` and `patchStats` go.
- Why it is risky: it is the widest of the three — a route that walks a whole transcript per read, a shape
  on every stored tool row and a Dexie bump — and it moves when a verdict appears: the change stream
  carries no content by design, so a verdict arrives on the next read rather than with the event that
  announces the round.

### 4. The limit notice infers that an account is out from the windows it holds

`limitNotice` (`src/lib/provider-usage.ts:73`) decides that a bot's provider account is out from the
windows the route returned — `tightestOf` over them, with a window that carries no reset time counted as
a balance rather than a period (`isBalance`, `:50`). That rule is an inference about the account where
core already states the fact: `AccountUsageWindow.scope` marks a window `account` (exhausting it exhausts
the whole login) or `model` (it caps one model family, and core's own words are that it "can never imply
the account is out of quota"), and `plugin/usage.py::serialize` drops the field before the app sees a
window. So a spent model-scoped window — anthropic's Opus week beside a healthy Sonnet week — reads as the
account being out while the account is fine, on a fetcher whose model-scoped windows are routine.

- Cost: the strongest wording the app has, "Limit Reached", is wrong on that account, and nothing in the
  windows in hand says whether it should have been.
- Suggested fix: `serialize` keeps `scope` on the wire (an added field an older app ignores) and
  `tightestWindow` skips a window core marks `model` when deciding the account is out — the sheet still
  states every window, the model-scoped one included.
- Why it is risky: every window a fetcher marks `model` would then stay silent, which is the right reading
  of core's own words but is not yet proven against a live account, and the app has to treat the field as
  optional (an older plugin sends none, and today's behaviour is what it gets). The balance rule beside it
  covers what users on Ollama Cloud and OpenRouter hit without a plugin change, so the field can wait for a
  model-scoped false alarm to be reported. Recorded, not applied.

---

Deferred by the same decision, each for the reason given: the app's model picker still derives its cost
tiers and modalities from its own models.dev cache (ADR 0005, considered options), `sessionState`
(`src/lib/workspace.ts:307`) stays a composition of the host's run status with this device's own marks
rather than a calculation, and the plugin's version and the app's `MIN_PLUGIN_VERSION` are not bumped yet:
the decision is one bump once the clusters that matter have landed, and the todo cluster degrades on its
own — an older plugin sends no progress, and the app shows the list without a count instead of working one
out.
