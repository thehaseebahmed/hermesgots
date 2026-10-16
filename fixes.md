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
