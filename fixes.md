# Deferred fixes from the reviews on AFK's switch

Two reviews of `feat(projects): switch a project to work its own tasks, kept on its host` — `/code-review`'s
two independent passes (the repo's documented standards, and the ticket with its parent spec) — turned up
one change too wide for the branch's own review pass. It is recorded here instead of applied: it rewrites
a handler this branch never touched.

Everything else both reviews found is applied on this branch rather than filed. From the standards pass:
`AGENTS.md`'s route enumeration names `projects/{id}/afk` (`:216`), and the sheet prints no line
explaining what a plugin can't do: a plugin without `afk_switch` shows the switch off and disabled,
matching the silence `skills` ("no error line") and `mcps` already keep, with the flow asserting the
control's state rather than any copy. The duplicated `makeProject`/`openAfk` the two flows carried are
one pair in `lib.mjs`, beside `setUpBot`; `readAfk`/`read` stay two bodies because they
differ in five things (route, setter, failure wording, `noteFailure` label, feature) and one reader taking
all five is longer and less clear than the two; `quiet` is `duplicate`, and `why`/`offers` are the
`reason`/`canSwitch` the plugin's own words already use; `projects`, `afk` and the neighbours build their
paths through one `projectPath`, so `getProjectTasks` stopped being the odd one out.

From the spec pass, and the real defect: `afk.state` used to answer off for an archived project by masking
the stored row, so a project archived from Hermes's own dashboard or CLI kept its `enabled = 1` and came
back on when restored. It now writes the switch off the first time an archived project's state is read —
which also collapsed the duplicated `why != ARCHIVED` in `state`/`set_on` — and the test asserts both the
row and the restore. A refusal is now `afk.Refused` rather than a bare `ValueError`, so the route answers
409 with the project's reason and only that; a fault in the store can no longer read as one. The ticket's
"working a task" state is not one this branch can prove — nothing consumes the switch until the sweep
lands (#263's own ticket) — so the flows cover idle, can't-be-on, on-with-a-reason and too-old, and the
frontier's rows under them.

## Risky

### 1. Three routes carry the same project preamble

`plugin/__init__.py`'s `project_tasks`, `project_afk` and `post_project_afk` each spell out the same
opening — `unauthorized`, `request.match_info["project_id"]`, `clones.is_pending_id`, `resolve_project` —
and this branch added the second and third copies of it.

- Cost: a change to how a project route authenticates, resolves a pending clone or answers an unknown id
  lands in three places, and the next project route copies whichever it lands beside.
- Suggested fix: one helper answering the project, with the pending-clone answer passed in as the
  caller's own — `tasks.empty()` for the frontier, a 409 for the switch.
- Why it is risky: the pending-clone answer deliberately differs per route today (a project still cloning
  has tasks that are empty, but no switch to offer), so the shared shape needs a parameter for it, and
  `project_tasks` predates this branch. Editing it here would put an untouched handler inside a switch
  feature's review, for a saving of three lines per route.

---

Found by the `/code-review` pass on this branch. Both axes' findings are fixed above except this entry,
and the pull request does not wait on it.

---

# Deferred fixes from the simplify pass on AFK's frontier

A cleanup review of `feat(projects): list a project's ready tasks in AFK's pop-up` (four parallel
reviewers: reuse, quality, efficiency, altitude) turned up changes worth making that are either
wider than this branch or a decision the read should not settle on its own. All but one is applied
here. The pass also found that the read stopped at a repository's first page of ready tasks; that
one is fixed on this branch rather than left as an entry, because a silent slice is a wrong answer
rather than a decision to wait on — the read now follows GitHub's `Link` header page by page, with a
cap that only stops a link pointing back at a page already read. The entry below is what remains.

Everything else the review found is applied on this branch: the read reuses `repos._repo_of` for a
project's repositories instead of parsing a checkout path a second time; a claimed task's blockers
are never fetched, since a claimed task is out of the frontier whatever it blocks; an issue whose
edges GitHub's own summary counts as all closed costs no second request; one `_claimed` predicate
answers "someone has this" for both the rule and the read; every row leaves `groups()` in one shape,
with an empty `blockers` list rather than a key some rows have and others don't; "GitHub says there
is no such issue" is `github.is_missing` rather than a second `"Not Found"` match; a blocker that
could not be read still counts as open, and the tests pin that beside the missing one; the library
and task routes resolve a project through one helper; and the app's per-connection feature answers
live in one `createStore` whose hook takes a whole registry, so the MCP screen no longer restates
six keys by hand and the AFK row reads the same store. The AFK sheet also reads through `usePoll`
with an abort and the house `lacksRoute` cooldown instead of its own effect, and its four states are
guard clauses rather than a ternary chain.

## Careful

### 1. A feature answer is kept for the whole session

`app/src/lib/features.ts` remembers each connection's answer and `readFeatures` returns early once
it has one, so a plugin upgraded while the app is open keeps its old feature list until the page is
reloaded: the AFK row stays hidden (or stays visible) on the strength of the list `/info` gave the
first screen that asked. `MIN_PLUGIN_VERSION` (`src/lib/version.ts`) raises an out-of-date warning
but does not refresh an answer.

- Cost: a Bot whose host was updated mid-session still reads as an older plugin, which for this
  branch means a menu row that exists and is not offered — the same silence the MCP screen already
  had, now that two screens share the store.
- Suggested fix: key the remembered answer on the plugin's version from `/info` (which the app
  already reads) and re-read when it moves, or clear the store when the version warning appears.
- Why it is not applied here: it changes when every feature-gated control is asked about, for a
  state only an in-place upgrade reaches, and the cache this branch moved out of `app/src/lib/mcps.ts`
  held an answer for the session too — so this is the existing rule made shared, not one the change
  introduced.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope except where a changed read could be wrong, which the tests pin — and
the entry does not block the pull request.

---

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

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and the one left does not block the pull request.

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

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the seven blocks the pull request.

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

`app/src/lib/model-match.ts:65` splices a per-family alias (`gemma4` → `gemma-4`) into a candidate
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

### 6. One tooltip root per capability per row

`app/src/components/chat/model-picker.tsx:351` mounts a Base UI `Tooltip` root for each capability a
model has, in a list that is not virtualised.

- Cost: a provider listing 100+ models mounts 200+ tooltip roots, all re-rendered while the search
  box is typed.
- Suggested fix: a single `Tooltip.Provider` or one shared popup, if the list is ever seen to jank.
- Why it is risky: mounting cost only, and unmeasured — the rows are small and the list is
  short in practice.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the three blocks the pull request. Two live checks the
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

`docs/adr/0006-calculations-belong-on-the-plugin.md` decides that a fact a bot's host could work out is
worked out on the host, and names the clusters to move. One of them landed with that decision: the todo
list's own progress and each item's depth, which the plugin states with the list
(`plugin/todos.py::progress_of` / `depth_of`, `GET sessions/{id}/todos`) and the app no longer works out
(`src/components/chat/todos.tsx`, `src/lib/todos.ts`). The three below are recorded rather than applied:
each changes a route, a capability gate and a stored shape, so each is its own decision, and the app has
to keep working against plugins already installed in the field. `migrations/` holds the work order for
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
  modalities, so this leaves two fetchers of the same public payload by design (ADR 0006) — and the
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

---

Deferred by the same decision, each for the reason given: the app's model picker still derives its cost
tiers and modalities from its own models.dev cache (ADR 0006, considered options), `sessionState`
(`src/lib/workspace.ts:307`) stays a composition of the host's run status with this device's own marks
rather than a calculation, and the plugin's version and the app's `MIN_PLUGIN_VERSION` are not bumped yet:
the decision is one bump once the clusters that matter have landed, and the todo cluster degrades on its
own — an older plugin sends no progress, and the app shows the list without a count instead of working one
out.

---

# Deferred fixes from the simplify pass on the composer's `/` menu

A cleanup review of the branch's two feature commits — `feat(chat): open the slash menu from any token
and cache the skills` and `feat(chat): size the slash menu to the room the screen gives it` — by four
parallel reviewers (reuse, quality, efficiency, altitude). Everything else the review found is applied
on the branch — the route-missing cooldown, the row dropped with its bot, the caret following the field,
the commands matching the whole message, the height never exceeding the room it measured, the bounded
`lacksRoute` probe and the noted failures. Four findings are recorded instead, because each is wider
than a cleanup pass.

## Risky

### 1. The capability probe answers one question for six readers

`hasPluginFeature` (`src/lib/hermes.ts`) turns a failed `/info` into `false`, exactly as it reports a
plugin whose features really lack the route. Five readers still ask it the wrong question —
`media-tags.ts` (an image silently does not load), `fallbacks.ts`, `research.ts` (a blip tells the user
the plugin needs updating), `sync.ts` (draft text silently off) and `chat.ts` (a queued message held
here instead of on the host) — while the skills read is the one that now asks `lacksRoute` instead, so
the repo has two answers to one question.

- Cost: a transient failure reads as "this host has no such feature" in five screens, each of which
  shows or withholds something on the strength of it.
- Suggested fix: give the probe a third answer — a `/info` that could not be asked returns `null`
  (unknown), `false` only for a list that really lacks the feature — and have every caller read unknown
  as "keep what we have", which is the rule the skills read now implements.
- Why it is risky: a shared contract change across five screens and their tests.

### 2. `skills.ts` hand-rolls the per-connection store the app already has

The module keeps a `Map` of answers and a `Map` of in-flight promises, and reads the answer map during
render from a hook each consumer wraps in its own state. The tree's shape for that is a module store
(`store.ts`'s `createSignal` + `useSyncExternalStore`, with `usePoll` for the refresh), which is how
`dictation.ts` and `projects.ts` cache one read per connection and share it with every consumer.
`hermes.ts` and `agent-card.tsx` are two more copies of it.

- Cost: the composer and the goal wizard each hold their own snapshot of one shared value, so a later
  reader can miss an update; a change to the sharing rule has to be made in each copy.
- Suggested fix: reshape the loader on `dictation.ts`, keeping the pure matching and hoisting in
  `slash.ts` where they belong.
- Why it is risky: refactor-sized, and the two maps plus the row write are correct today.

### 3. The menu's height re-derives what the positioning layer publishes

The list measures the room above the composer itself (four constants, a `ResizeObserver` and four
viewport listeners). Base UI's positioner already computes `--available-height` from a keyboard-aware
viewport rect, and the app's own menus use it (`popup.tsx`, `ui/dropdown-menu.tsx`, `ui/select.tsx`).
The constant also now lives in three places: the component, the browser flow's assertions and the ADR.

- Cost: layout code that must stay in step with the framework's own measurement, and numbers the flow
  restates rather than pins.
- Suggested fix: render the list inside the app's positioned pop-up and size it with
  `max-h-(--available-height)`; failing that, have the flow import the constants instead of repeating
  them.
- Why it is risky: moving the list into a portal changes focus retention and the
  `aria-controls`/`aria-activedescendant` wiring the inline element gets for free.

### 2. The note a compaction writes into the transcript renders as the user's own message

**Applied since.** The fold reads the three headers Hermes writes at the boundary off a `user` row's
text, and each counts only with the payload the host writes under it — an item line, the notice's
body, the restated request — so a message quoting the host's words stays the user's. A row carrying
nothing but those notes draws nothing, closes nothing and starts no turn; a row restating the
in-flight request draws only that request. A device that had already drawn the bubble keeps it no
longer: catch-up drops a message held for a row that folds to nothing and rewrites one that drew a
restatement's header. The rule is `app/src/lib/compaction-seam.ts`, its sentences and the markers its
snapshot items are read by both pinned and both held to Hermes's own constants by
`hermes-internals-drift.yml`; `scripts/test-compaction-seam.mjs` drives it, `test-compaction-seam.tsx`
the fold and that repair, and `history-generations` asserts both notes draw nothing in a browser. One
residual is left: a user who types the whole of the host's prose *and* its payload loses that message,
or who pastes a snapshot with text of their own below it, which is the cost of matching text where
Hermes stores no flag.

Hermes marks the seam a compaction leaves with a row addressed to the model — "the active task list was
preserved", "still in progress" — stored as a `user` row. `isNotice` (`app/src/lib/history.ts:192`)
recognises only the `[System:` form, so a turn-start row like this one is neither skipped nor folded:
`toMessages` maps it to a user message and the thread draws it in a user bubble, exactly as the
reporter's screenshot shows between the two copies of the same turn sequence. It is not text the user
typed, and it is the one row in the thread that no device ever sent.

- Cost: a long chat that has been compacted shows a message in the user's own voice that they never
  wrote, at the seam where their turns were carried across — and, because it starts a turn, it can
  also take a reply's place in the thread's ordering until a real turn follows it.
- Suggested fix: widen the notice rule to the shapes Hermes writes for a session-internal seam (the
  `[System:` rows it already knows, and the task-list preservation note), keeping it a predicate over
  the row's text so nothing else changes; `history-generations` then asserts the marker is not drawn
  as a user message, which is the case a compaction flow can hold.
- Why it is risky: it decides what a user is allowed to see of Hermes's own bookkeeping, and the
  widening has to be exact — a rule loose enough to catch the note could swallow a message a user
  really began with a bracket. The flow's mock would have to emit Hermes's real wording rather than a
  paraphrase, since the match is textual.

### 3. A restatement can draw the request it restates a second time

The host drops the restated row's timestamp on purpose, so `carried` — the pairing added for the
re-emitted compaction rows, which matches a copy to the turn it repeats by time — cannot recognise it.
When the device already holds the original request's row and the transcript also carries the
restatement, both fold to a message and the thread draws the same request twice.

- Cost: a chat compacted while a turn was in flight shows that turn's request as two consecutive user
  messages. It is smaller than what it replaces (the restated row drew the whole note, header and
  all), and it is not this branch's doing: the copy existed as a note before, and only its text is
  better now.
- Suggested fix: pair a restatement to the message it repeats by the request it carries, limited to rows
  that open with the replay header — so a user who sends the same words twice is untouched — and drop
  the copy rather than the original.
- Why it is not applied here: no repro beyond a hand-built pairing, and a pairing rule that guesses
  wrong deletes a message the user sent, which is the failure this branch exists to stop. It wants its
  own change and its own red loop against a real transcript.

## Not entries

- **The e2e restates the layout numbers** (`288`, `520 * 0.5` against `SCREEN_SHARE = 0.45`), so the
  assertions cannot catch a constant drift. Recorded in the suggested fix above rather than as its own
  entry: the same decision (where the numbers live) covers both.
- **`rankSlashItems` and the skill-item map re-run on every composer render** while a token exists,
  which includes the chunks of a streaming reply. Measured as microseconds against the list re-render
  beside it, and a memo would have to key on four values because each render makes a fresh array — not
  worth the machinery, and a number quoted for it would be a guess.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt: the
reviewers did turn up two real defects — a draft beginning with `/` opening the menu with the caret
mirrored at 0, and a first-token command offered under text that running it would have dropped — and
both are fixed above rather than deferred, because each is the behaviour the design already promised.

# Deferred fixes from the simplify pass on the model divider

A cleanup review of the model-divider branch (`fix(chat): ask the host for a chat's model record as a
turn opens`, its restyle and its test follow-up; four parallel reviewers: reuse, quality, efficiency,
altitude) turned up one change too wide for a cleanup pass. It is recorded here instead of applied:
it moves where a read is scheduled, which is a decision of its own.

Everything else the review found is applied on this branch: the unit case that repeated an existing
one byte for byte is gone (the count is 15, not 16), `turnModel` lost its fourth argument and its
duplicated return, the context read it fires is coalesced per chat and now carries the house timeout,
the send path skips the whole thing for a bot with no key, the mock parses the profile path once for
both the request handler and the leaf that records the model (and carries the url on the turns its
run and queue paths synthesise), the divider's comment no longer claims the wave is unscaled, and the
glossary entry is one line like the rest of that file.

## Risky

### 1. The model record has no read of its own

`src/lib/context.ts::refreshContext` is documented as reading a chat's *context use*, and it happens
to carry `model_changes` because the plugin's one route answers both. The send path now fires that
function to get the record, so the model list's read depends on the context ring's function — its
write of `liveContext`, and its clear of both fields when the route is missing — and it fires
outside the accounting that owns this policy: `src/lib/history.ts::followUps` and `noteFollowUps` are
where "when a chat's follow-up reads run" is decided and recorded, and the root `AGENTS.md`'s layout row
already has to describe the split, crediting `model-changes.ts` for a read it does not perform.

- Cost: three modules to consult to answer "where does a chat read the host's record", and the next
  caller that needs the record repeats the reach-through. The request-budget flows
  (`pnpm e2e idle-requests`) have a hole where a read is not recorded as a follow-up.
- Suggested fix: a `refreshModelChanges(conversationId)` sharing `getSessionContext` and writing only
  `modelChanges`, with `refreshContext` composing it (one HTTP request, unchanged), and the "when"
  left where the other read scheduling lives.
- Why it is risky: it splits a shared write path (the missing-route branch clears both fields
  together) and moves a read's scheduling into a second owner, which the ADR deliberately kept in one
  place. ADR 0010 settles the *exception* (one fired, unawaited read on a send); which function fires
  it is the part it does not.

## Not entries

- **`hostModel` and `hostProvider` read the same row twice** (`scripts/mock-hermes.mjs`). A single
  accessor would do, but the pair defaults differently (`?? HOST_DEFAULT_MODEL` against `?? null`) and
  both call sites use them together; the duplication is a dev-only mock's, and low confidence.
- **The rationale lives in three comments and the ADR.** The call-site comment was trimmed to why the
  read is fired there; the docstring keeps the predicate's own account, which is what a reader of
  `unknownLastTurn` needs without opening the ADR.
- **`unknownLastTurn` re-walks the thread through `turnModel`.** Deliberate: the gate and the
  placement must answer the same question, so they share the one function rather than growing a
  second rule that can disagree with it.
- **The e2e's blank scenario repeats the seed → pick → send shape above it.** That is what a scenario
  script is; the flows have no shared page-side scenario helper by design.

---

Found by the `/simplify-code` pass on the model divider. It was a cleanup review, not a bug hunt, but
it did surface one real defect of this branch's own making: the mock's leaf read the profile off a
request object with no url, so a named profile's turn recorded the default profile's model. Fixed
above rather than deferred — it is the fidelity the mock exists for.

---

# Deferred fixes from the simplify pass on removing an MCP server

A cleanup review of `feat(settings): remove an MCP server from its row` (four parallel reviewers:
reuse, quality, efficiency, altitude) turned up nine findings. Five are applied on this branch, three
are narrower than an entry and sit under **Not entries** with the reasoning that declined them, and
one is rejected outright with the evidence that settled it.

Everything else the review found is applied on this branch: the read and a removal answer through one
`mcp._all_rows`, so the order the app's list is in has one owner instead of one `sorted(...)` tail in
two functions; the mock's two MCP writes ask one `mcpWritableServer` for the lookup and the two
refusals, so the plugin's wording is hand-copied in one place instead of two; the feature *answer* is
named `removable`, so the screen no longer aliases it against `useMcpServers`'s `remove` action; the
confirmation holds the server's name rather than the row it came from, so one row can't disagree with
the list it is drawn in; and `/info` checks the removal's gate only once the switch's has passed,
since `_hermes_remove` is `_hermes_write` plus two imports and cannot succeed where that failed.

## Rejected, with the evidence

### The removal may drift from `hermes mcp remove`

The altitude pass read `plugin/mcp.py::remove` reassembling Hermes's own removal out of granular
built-ins (the catalogue's uninstall, the OAuth manager, the reconcile) rather than calling a single
Hermes entry point, and flagged a drift risk. Read at the source the branch pins
(`NousResearch/hermes-agent` at `bb834a2c`), `hermes_cli/mcp_config.py::cmd_mcp_remove` does exactly
those two things — `_remove_mcp_server(name)` and `get_manager().remove(name)` — wrapped in a
confirmation prompt and console output a route may not run. There is no third step to drift from, and
`uninstall_entry` adds the one thing the CLI leaves behind (the directory Hermes cloned), which the
ticket asks for by name. Nothing to change; the reasoning lives in the module and PR notes.

## Not entries

- **The flow's mock reset ignores its own response** (`app/scripts/e2e/mcps-remove.mjs`, the
  `finally`'s `POST /__mock/mcp`). A reset that fails leaves the removed server in the mock for the
  next flow, which then fails as a missing fixture rather than as a failed reset. It is the house
  pattern — `prs.mjs` and `plan-mode.mjs` reset the same way — so the fix is a shared dev-only helper
  for every flow that resets state, not a change to one of them.
- **The hook's two write callbacks restate their config and timeout** (`app/src/lib/mcps.ts`,
  `setEnabled` and `remove`). Each needs its own `AbortSignal.timeout(...)` — a shared signal would
  expire and abort the second call — and the callbacks' dep arrays are the primitives, which is why
  neither reads the `config` object the poll already builds. A shared wrapper would save a few
  characters and put the signal's lifetime one indirection away from the call that needs it.
- **`_hermes_write()` re-imports the readers rather than building on `_hermes()`**
  (`plugin/mcp.py`). The two sets genuinely differ — the read takes the profile's secret scope, the
  write Hermes's config write scope — and each 501 names the built-ins its own caller needed, so the
  split is the module's contract rather than a third layering idiom.

---

Found by the `/simplify-code` pass on this branch. It was a cleanup review, not a bug hunt —
correctness was out of scope — and none of the findings blocks the pull request.

---

# Deferred fixes from the reviews on browsing the MCP Catalogue

Two reviews of `feat(settings): browse a bot's Catalogue from its MCP screen` — `/simplify-code`'s
four parallel reviewers (reuse, quality, efficiency, altitude) and `/code-review`'s two independent
passes (the repo's documented standards, and the ticket with its parent spec) — turned up changes
that are wider than this branch or belong to another mechanism. They are recorded here instead of
applied.

Everything else both reviews found is applied on this branch. From `/simplify-code`: the sheet's
search field is the shared `ItemSearch` (`src/components/item-list.tsx`) rather than a fourth
hand-built copy of `InputGroup` + `SearchIcon`; `useMcpCatalogue` reads once per open
(`onShow: false`, as the feature answers already did) instead of again on every tab refocus; both
hooks take their connection through `serverConfig()` rather than rebuilding the `{baseUrl, apiKey}`
prologue, and now share the read body itself (`landRead`, which owns the never-set-after-abandoning
rule) with the servers hook; the `enabled` mark is gone from the answer the plugin, the mock and the
app carry, since the screen marks Added from `installed` alone; and the entry read is one expression
(`getattr(entry, "description", "") or ""`) with the test fake shaped like Hermes's own
`CatalogEntry`, whose `description` is a required field.

From `/code-review`: the plugin's route reference (`plugin/README.md`) documents
`GET /mcp/catalogue` beside the other MCP routes, and `plugin/mcp.py`'s module docstring no longer
names a built-in the code doesn't call. The findings about *where a thing is declared* are applied
too: `plugin/mcp.py`'s `FEATURES` table (`:294`) is now the one place a feature and its gate are
named, with `info` deriving its advertised list from it rather than naming the four in the payload
beside three local booleans (`plugin/__init__.py:241`, `:290`), and the app's `MCP_FEATURES` record
(`app/src/lib/mcps.ts:35`) is the one place a key and its feature string are tied, with
`useMcpFeatureAnswers` reading every subscription from it. The catalogue also takes Hermes's own read
of the profile's servers once for the whole list (`installed_servers()`, pinned by
`test_the_whole_catalogue_costs_one_read_of_the_profile`) where it asked Hermes's per-entry check
once per entry: N config loads become one, which is the mechanism the notes document rather than a
measurement — Hermes isn't installed in the container this branch was written in, so the wall-clock
saving is unmeasured.

## Rejected, with the evidence

- **Project each entry through Hermes's own `_catalog_entry_json`** — the shape the notes recommend
  for a UI (`notes/mcp-servers/hermes-mcp-internals.md:281-286`). That projection emits each entry's
  declared values (`required_env`, `url`, `args`, `post_install`, `auth_type`), and this read's
  contract is the opposite: "no value an entry declares is read or answered"
  (`plugin/mcp.py::catalogue`'s docstring, and the ticket's read-only scope). The reduced
  name/description/installed shape is the boundary the ticket asks for, not drift from Hermes's
  shape. Re-opening this is only right for the add step, which owns declared values.
- **Keep the `enabled` mark and surface it, rather than dropping it.** `#249`'s API contract names
  this route as "the Catalogue, with installed/enabled per entry and each entry's declared values",
  and this read answers `installed` alone. The ticket this branch implements (`#253`) asks for the
  entries and "the ones this Bot already has", and nothing on the screen reads either of the other
  two: `enabled` would be a field no reader has, and the declared values are what the add step
  (`#254`) has to show, since they are what a person chooses between. The reduced shape is the
  ticket's boundary; the rest of the parent's row arrives with the step that needs it.

## Not entries

- **`ServerRow` hand-builds what `RowText` now provides** (`app/src/routes/mcps.tsx:190` against
  `:300`). It predates this branch — the title/subtitle span arrived with the read's screen
  (`git blame`: `bb1e70e`) — and the two rows on this screen are not the same anatomy (a server row
  carries a state badge and controls between the text and the end), so this is one screen's row shape
  rather than a duplicated component.
- **The mock cannot turn off one MCP feature**, so `mcps-gate` rewrites the `info` answer in the
  browser (`app/scripts/e2e/mcps-gate.mjs:23`) and this branch adds a fourth call to it (`:108`),
  while the mock's own `/mcp/catalogue` route (`app/scripts/mock-hermes.mjs:1523`) is only ever
  exercised with the feature on (`:1490` ties all four to one switch). The fix is a feature setter in
  the mock plus a home in `scripts/e2e/lib.mjs` for `gate()`, which is the e2e harness rather than
  this flow; `gate()` moves when a second flow needs it.
- **The plugin's routes and handlers stay one per verb** (`plugin/__init__.py:396`, `:1192`). The
  `FEATURES` table could name each feature's route and handler too, but every route keeps its own
  handler — the write reads a body, the removal takes a name from the path and answers the list it
  left — and its own method, so the table would replace three `add_get`/`add_post`/`add_delete` lines
  with a loop over tuples: the wiring pointing at itself rather than a declaration. What the review
  found — a feature named by hand beside its gate, in the payload and on the screen — is fixed.
- **The plugin-answer envelope is unwrapped per reader** (`app/src/lib/hermes.ts:400`,
  `:493`). One `parsePluginObject(value, key, mapper)` would cover them, but the same shape recurs
  across the file's other plugin reads, so the helper is a change to that whole client rather than to
  this read.

---

Found by `/simplify-code`'s four parallel reviewers and `/code-review`'s two independent passes on
browsing the MCP Catalogue. `/simplify-code` was a cleanup review and `/code-review`'s spec pass
checked the ticket's own acceptance criteria — all met — so neither was a bug hunt, and none of the
findings blocks the pull request. Every finding either landed on the branch or is recorded above;
the plugin suite and the four browser flows that cover this screen were re-run after the last of
them.

---

# Deferred: a message sent as a stop takes effect is steered into the turn being stopped

The diagnosis of the duplicated and misplaced turns in a long chat separated two mechanisms. One is
fixed on the branch that recorded it: Hermes's compaction re-emits the carried tail under fresh row
ids, and catch-up adopted each copy as a new turn, so a turn the device already had was appended
again. The other is how a message reaches the middle of a turn at all — a plain send while a reply is
live is stored as a *steer*, and the composer decides which it is from one local flag. One of the two
findings below is applied since; what it cost while it stood is kept with it.

## Risky

### 1. "This run is live" is a local row's status, and a stop does not change it

`app/src/components/chat/composer.tsx:182-183` sends as a steer when `busy` is set, `onSteer` exists,
no files are attached and the pick (or the setting) says steer; `busy` is `Boolean(streaming)` over
the local rows (`app/src/routes/chat.tsx:270-271`), where `streaming` is the row whose status is
`streaming`. `steerable` (`app/src/routes/chat.tsx:302`) narrows that to a run id and a host that has
the route, and `onSteer` (`:914`) hands the text to `steerText` (`app/src/lib/chat.ts:1481`), which
queues it and then calls `steerQueued` (`:1449`) — and `steerQueued` steers whenever the turn still
carries a `runId` (`:1451`, `:1463`). `stopMessage` (`app/src/lib/chat.ts:1496`) fires `stopRun` and
aborts the stream but records nothing the composer can read, and the row's status only clears when
the abort unwinds through the turn's own `finally`. So between the tap and that unwind, and against a
host whose run keeps going after a best-effort stop, a send is steered into the run being stopped
rather than starting a turn: the host appends the text inside that turn — the reporter's transcript
holds exactly such a `steer` row mid-turn — and every device that reads the transcript afterwards
shows it there. That is the "my message landed in the middle of a turn I had stopped" half of the
report.

- Cost: a message sent after ending a reply is stuck inside it — its position, and any follow-up the
  steer carries — and no screen says it went that way. The app has no answer to "this run was
  stopped" separate from "this run is live", which is also why a steer can be offered under a reply
  the host has already ended while its row is still open here.
- Suggested fix: record the stop when `stopMessage` runs — a `stopped` mark on the turn, cleared
  when the next turn opens, or the pending `stopRun` promise awaited by the send path — and read it
  in one predicate the three sites share: the composer's steer branch, `chat.tsx`'s `steerable` and
  `steerQueued`'s `runId` check. A send during or after a stop then queues as its own turn instead of
  steering into a dead one.
- Why it is risky: it changes what the composer does with a send on the app's busiest screen, and the
  queue's path (`queueMessage`, `app/src/lib/chat.ts`) then receives messages that today never become
  rows. Steering is a deliberate model — a setting (`steerByDefault`), a queue action and the row it
  leaves in the thread — so the change has to keep an explicit steer working, which means separating
  "the run is live" from "the user asked to steer". No flow sends while a stop is taking effect, so
  one has to be written with it.

## Not entries

- **A carried row Hermes didn't stamp with a time** (`history.ts:706`, `:737`) is added as it always
  was, since the recognition is by time. Every row in the reporter's transcript carries one, and the
  only other thing on a row that survives a re-emission is its text — a match on text alone cannot
  tell a compaction's copy from a user who really sent the same message twice, which is the case the
  match exists to keep apart.

---

Found while diagnosing the duplicated and misplaced turns in a long chat, against the reporter's own
transcript (its rows carry the re-emitted compaction generations). The duplication is fixed on that
branch, the seam note since (above), the second copy a restatement can draw still to do; the steer
below is not, and the steer-as-a-plain-send model it sits inside is the user's setting rather than a
defect. They came out of reading the same transcript and a review of the fix rather than from a repro
of their own: what is verified is the shape above —
one local status decides the send's kind and a stop leaves it set — read in the tree and matched
against the transcript and the reporter's screenshot. The four chat flows (`chat-message`,
`reattach`, `history-pages` and the branch's new `history-generations`) all pass, and none of them
stops a reply and sends in the same breath; what a compaction's seam row draws is asserted by
`history-generations` since the note fix.

# Deferred from the code review on the MCP tab

## Careful

### 1. The error-toast fallback is hand-written eight times, and the helper it wants is app-wide

A write's failure is shown by hand at each of the tab's write paths:

```ts
toast.error(error instanceof Error ? error.message : "Couldn't add that.")
```

`app/src/components/mcps-tab.tsx` has eight of them — the removal (`:124`), a switch (`:383`), a
Config save (`:774`), the Catalogue's add and its form's add (`:974`, `:1109`), the custom form's
(`:1228`), Server access's start (`:1346`) and its callback's (`:1392`) — differing only in the
sentence used when the throw isn't an `Error`, and one of the eight (`:1346`) sets a field of the
access sheet rather than raising a toast, so the same expression has two destinations.

- Cost: eight copies of one rule about how a Host's refusal is shown, where a change to the rule —
  a reason the Host sent as text but not as an `Error`, say — is a change in eight places that a
  reader has to find.
- Suggested fix: one `messageOf(error, fallback)` in `app/src/lib/` (beside `report.ts`, which
  already holds the app's other "what went wrong" helpers), returning the throw's own sentence or the
  caller's, called at all eight sites and at the other sites that share the shape.
- Why it was not fixed here: it isn't a local duplication, it is the repo's idiom. The same
  expression stands 45 times across 24 files in `src/` — `src/routes/chat.tsx` (4),
  `src/components/bot-settings.tsx` (4), `src/lib/sync.ts` (3), `src/routes/project.tsx` (2),
  `src/lib/chat.ts` (2), `src/components/project-settings.tsx` (2), and one each in a dozen more.
  Only thirteen of them are this branch's (the eight here, four in `bot-settings.tsx`, one in
  `mcps.ts`); the rest predate it. Adding the helper inside one screen's diff would leave that
  screen the only one calling it, which is a worse outcome than the duplication: the next reader
  would have two idioms to learn and no way to tell which is current. The honest fix is one commit
  over the whole app, with the helper named for what it answers and every site converted, so the
  idiom has one home.
- Why it is risky: mechanical, but wide — 45 call sites, on paths that show a user why a chat, a
  sync or a write failed, and a fallback sentence is user-facing copy the conversion can silently
  change if a site's own wording is mistaken for the helper's default.

---

# Deferred from the review of the run poll's lineage walk

`sessions.chat_session` reads a chat's compression lineage out of Hermes's `state.db` so `runs/live`
can key a run on the session the chat started as. That made it the third walk up
`parent_session_id` in the plugin, and the three don't agree: `chat_session` follows only a
compression continuation and goes 1000 deep (Hermes's own cap), while `push._lineage`
(`plugin/push.py`) and `record_for` (`plugin/sessions.py`) follow any parent and stop at
`MAX_PARENT_HOPS` — six. A chat compressed more than five times therefore resolves to a mid-chain
session for push's title and mute while `runs/live` resolves it to the root. Separately, five
modules open `state.db` with their own copy of the read-only URI, timeout and error policy
(`delegation`, `push`, `projects`, `cleanup`, `research`); this branch gave `sessions.py` one
(`_open_state`) and left the rest.

- What the fix is: one `host_store`-style reader (a read-only connection, one error policy) and one
  `lineage(home, session_id, stop=...)` over it, with the stop condition as its argument, called by
  all three walks.
- Why it is not in this branch: it rewrites `push.py` and `record_for`, neither of which this diff
  touches — `record_for` answers the nearest *record*, not the root, and folding it in changes what
  the hooks answer for a delegated turn.
- Why it is risky: those callers feed worktree resolution (`record_for_call`) and push routing, so a
  wrong id writes a session's plan or a notification under another chat; and the five readers are
  on paths from a background clone to the dashboard, each with an error policy somebody chose.

---

# Deferred fixes from the simplify pass on the critique's briefs

A cleanup review of `feat(afk): brief each critique reviewer on its own skill` (four parallel
reviewers: reuse, quality, efficiency, altitude) turned up one change too wide for a cleanup pass,
recorded here instead of applied: it rewrites how a staged task's base branch is read, which this
diff only repeats into a new place.

Everything else the review found is applied on this branch: each brief is built from values read
once, so one prompt build no longer reads the session's pipeline twice; the skills line is data
only, with the rule about how many reviewers each skill gets stated once, in the critique stage's
fixed text; the fixed points every skill has to respect live in one `_SKILL_SCOPE` the build's line
and the critique's block both use, so the two can't drift apart again; the worktree clause is built
without a leading space the caller has to know about; and the issue reference is read as the named
tuple it is instead of a positional unpack that throws a field away.

Three findings are declined rather than filed. A reviewer's brief does not repeat how to read the
issue (`gh issue view …`): it names the issue and its url, and every reviewer is a Hermes agent with
the tools to read a link — the command would be repeated in full once per skill. The number of
critique skills a project may pick is unbounded, which the picker and the ticket both intend ("one or
more"), so a cap is a product decision rather than cleanup. And a repo whose record holds no worktree
path is left out of a brief rather than named as unknown: `sessions` writes a path for every worktree
it makes, so the row that would hit it is a hand edit outside what a prompt builder has to defend
against.

## Risky

### 1. One base branch stands for every repo's

`afk.base_branch` reads one branch from the record's first repo — its worktree path, whose
`projects._base_branch` fallback (`git branch --show-current`) answers the session's own branch when
`origin/HEAD` is unset — and `critique_prompt` hands that one value to `_base_line` and to every
reviewer's brief. `ship._repo_status` (`plugin/ship.py`) answers the opposite: a base per repo, read
from each repo's `repo_root`, which is what each pull request is opened against.

- Cost: a project whose repos default to different branches (`main` here, `master` there) briefs
  every reviewer against the first repo's branch, including the reviewers reading the second repo's
  worktree; and in the fallback case it can name the session's own branch as the base, which is not
  a branch the change is against at all. The prompt states it twice — once in the base line and once
  in each brief — so the wrong value is hard to miss and easy to believe.
- Suggested fix: carry the base per repo, from `ship.status` or from `projects._base_branch(repo[
  "repo_root"])`, and render each worktree with its own base in the brief; `critique_prompt`'s
  `base` parameter and `_base_line` then go away.
- Why it is not applied here: the scalar predates this branch (`#328`), and the fix changes the
  prompts every staged task gets plus the `critique_body` signature, and settles how a multi-repo
  project's bases are read — a decision that belongs beside `ship`'s own per-repo handling rather
  than in a cleanup of the briefs that repeat it.
- Why it is risky: the same read feeds `pipeline.advance`'s commit count through `ship.status`, so
  changing which path the base comes from can change a gate's verdict as well as a prompt.

---

Found by the `/code-review` pass on this branch, whose other findings are fixed rather than filed: the
briefs now speak to the reviewer they are handed to instead of describing it in the third person, the
skills line no longer restates how many reviewers a skill gets, and the two commit summaries that ran
past 72 characters were folded into the pass they belonged to.

## Risky

### 1. A reviewer is told not to write, and nothing refuses it

`critique_briefs` ends every reviewer's brief with "You report rather than implement: change nothing,
commit nothing and ship nothing." The only machinery behind that is the brief itself. A delegated
agent runs as a child of the critique session, and `sessions.before_tool`'s refusal of mutating tools is
keyed on the session's own mode — plan mode — which a staged critique session is not in, since it has
to fix what it accepts: so a reviewer that decides to "just fix" a finding can edit the worktree, and
the run then weighs that edit as something it did.

- Cost: the separation the stage exists for collapses — the author and the reviewer become one voice
  again, exactly what delegating with fresh eyes is for — and nothing in the transcript or the record
  says which change came from which. It is the one criterion of #324 that holds by instruction rather
  than by the host.
- Suggested fix: refuse mutating tools in `pre_tool_call` for a child task of a session whose pipeline
  stage is `critique`, the way plan mode refuses them for a session, allowing the reads and the shell
  reads a review needs.
- Why it is not applied here: it changes what every delegated child of a staged session may do, and it
  needs a way to tell a child task from the one that owns the session — the hook is handed a task id
  and a session id, not a parent. That is a decision about delegation itself, not about the text this
  ticket writes, and the brief has been the whole enforcement since the stage shipped.
- Why it is risky: a predicate that gets the child check wrong either blocks a reviewer's reads or
  blocks the critique session's own fixes, and the second leaves a staged task unable to ship — the
  same stall a failed gate is supposed to produce, but for a reason nobody would look for.

---

## Risky

### 1. A stage's skills are told what to apply to, and only shipping says "the diff"

`_steps_line` (`plugin/prompt_builder.py`) decides where a stage's skills are applied from
`pipeline.ships`: the stage that ships is told to apply each skill to the diff, and every other stage
to follow it for how that part of the work is done. The workflow snapshot records which stage ships
and which skills each stage names, but nothing in it records what a stage's skills are meant to look
at.

- Cost: a workflow cannot express a stage whose skills read the diff without that stage also being the
  one that ships — a second review, or a Polish stage a project puts before the review, is told the
  work is theirs to write — and the one place the distinction lives is a boolean read for another
  purpose, so the next workflow shape inherits whatever scope the flag implies.
- Suggested fix: carry where a stage's skills apply in the workflow's own model — a field beside
  `steps`, `ships` and `check`, defaulting to the build's wording and to the diff for the shipping
  stage — and have `_steps_line` read that rather than infer it from `ships`.
- Why it is not applied here: it is a change to the snapshot and to everything that reads one
  (`pipeline.start`, the library's presets in `workflows.py`, `for_app` and the app's reading of it),
  while #336 is the prompt's ticket and states the rule ADR 0020 already has — the stage that ships
  reviews the diff. Widening the model is a workflow-feature task, not a cleanup of this line.
- Why it is risky: a snapshot written before the field exists has to keep reading as it does now, so
  every read needs the default to be right, and a wrong one changes what every stage of every
  workflow is told about its skills.

---

Found by the second `/simplify-code` pass on this branch. Its other findings are declined rather than
filed, each with the spec as the reason: the fixed-points guard stays stated for every stage,
including one that names no skill (#336 asks for exactly that), and the guard's placement outside each
brief follows from ADR 0020 making the brief the stage's behaviour contract rather than a place for
AFK's invariant.

---

# Deferred fixes from the review passes on a reply's thinking in runs

`feat(chat): draw thinking in a coding session's thread` (#477, on the branch that carries #474's runs)
went through a four-agent `/simplify-code`, a comment pass and a two-axis `/code-review`. Everything
but this entry is applied on the branch: the order two runs land in after back-to-back calls, the open
gate over a run whose span says it ended, the watcher's shape and lifetime, a folded row's tab order,
the follow's arming and its writes, and each test's tier (ADR 0019).

## Risky

### 1. The thinking row follows its own end with a scroll engine of its own

`thinking-line.tsx` scrolls the thread itself while a run is open: it lands the row's end on open
(`scrollIntoView`, smooth unless motion is asked against), arms a `ResizeObserver` on the row, and
takes a wheel, key or touch move up as the reader leaving — then keeps writing `scrollIntoView` as the
run's words arrive. `MessageScrollerProvider` (`message-scroller.tsx`) runs its own `autoScroll` over
the same box, from measured anchoring, with its own notion of whether the reader is at the end.

- Cost: two writers on one scroll box, each reasoning about the same state without seeing the other.
  The row's engine only hears the reader through input events, so a scrollbar drag, a momentum stop
  after a fling, or a keyboard scroll on another element leaves the follow armed and fighting the
  provider's anchoring; and every new way the thread moves itself is another thing the two can
  disagree about.
- Suggested fix: give the provider the one answer to "is the reader at the end" and have the row ask
  it — the follow becomes "keep this row's end in view while the provider says the reader is at the
  end, and the row's own `aria-expanded` says it is open" — with the agent pop-up's transcript wired
  through the same scroller primitive so a sub-thread's rows behave as a chat's do.
- Why it is risky: it is a rewrite of the thread's scroll ownership. The blast radius is outside this
  diff — `message-scroller.tsx`, `popup.tsx` (`PopupContent` wraps its children in a plain
  `overflow-y-auto` `Scroll` box) and `agent-card.tsx`'s `AgentView` — and a wrong answer there moves
  every thread in the app, not one row's follow.
- Why it is not applied here: the row-scoped follow is the shape #476 specifies, and the flow proves
  it end to end (the tail stays in view while the run streams; a wheel up stops it; a tap re-arms it).
  Detecting the reader's own scrolling from `scrollTop` was tried and measured against the provider's
  own anchor scrolls, which move the box without the reader touching it: it fired on them and stopped
  the follow the moment the thread anchored itself. The input listeners are what survived that test.

The safe half of the same finding is filed rather than applied: `scroller()` walks ancestors asking
`getComputedStyle` for an `overflow-y` that scrolls, which is a layout read per ancestor per open. A
shared attribute — the thread already has `data-slot=message-scroller-viewport`, and a pop-up's
scrolling box is `Scroll` in `popup.tsx` — would let it match attributes only. It is not applied here
because the pop-up's box is shared UI's, so marking it is a change to every pop-up in the app for one
row's sake, and nothing in this diff can prove the agent sub-thread's follow still lands without a
browser.

---

Found by the `/simplify-code` and `/code-review` passes on this branch. Both flagged the second scroll
writer; the simplify pass found the attribute walk as a cheaper subject for it.

---

# Deferred fixes from the review passes on cards filling the chat's pane

Three passes ran over this branch — the four parallel simplify reviewers, Comment Sicko over the
diff, and the two-axis `code-review` (standards and spec). Everything they found that the branch
introduced is applied on it: the 768px box shared as `COLUMN_BOX` beside the column it holds,
`CARD_BASE` behind every card's surface (the approval's ring included), the footer's lines as the
list that decides whether the footer is drawn, the slot's dead wrappers gone and the slot named for
the slot, the flow's three widths in one walk — 1440px now asserting the card stops dead at the
768px cap the reading column's box carries (ADR 0047) — the comment cuts, the e2e skill's pane
arithmetic corrected against what the flow
measures, the `FLAT_CARD` rename the `ThreadCard` collision needed, `layout.ts`'s row in AGENTS.md's
map, and the ADR, spec and audit worded to what was built. The entry below is what remains; the
rejections follow it.

## Risky

### 1. The registry test reads the CLI's source as text

`app/scripts/test-e2e-registry.mjs` finds the flow table with `cli.indexOf("const FLOWS = {")`,
slices to the next closing brace and matches keys out of that slice — the registry is parsed out of
source because importing `e2e/cli.mjs` would run it: the CLI reads `process.argv` at module scope
and tears its servers down in a top-level `finally`.

- Cost: renaming the table, its braces or its indentation empties the registry, and the failure
  reads as an audit mismatch rather than a rename; every new check against the table re-implements
  the same slice, and the apology for doing so lives in a comment rather than a type.
- Suggested fix: move `FLOWS` into an importable module the CLI and the test both read, with the
  CLI's argv handling and its teardown behind an entry point.
- Why it is not applied here: the parsing predates this branch — #497 changed only the `STAYS`
  constant beside it — and the extraction rewrites the sweep's entry point, which is e2e
  infrastructure rather than this ticket's layout.

## Not entries

Declined with the evidence, each for what it is:

- **`STAYS = 10` and the test title's "the ten"** — a pinned policy, not a restatement: the audit's
  own counts are already checked against its rows, so this constant is the second key to the same
  lock, and deriving it from the audit would assert nothing.
- **The footer's gate** (`footerLines`, the filter, the wrapper) — an empty row would still add two
  of the message's `gap-3`s around itself; the gate is that constraint, stated in the one line
  beside it. The suggested alternative needs `StatusLine` and `Stats` to grow a `className` prop for
  no pixel change.
- **`[data-slot="composer-slot"] [data-slot="card"]` measures whatever card is in the slot** — the
  slot's ternary renders one card at a time, and the flow waits on the waiting Question's own button
  before it measures, so any other card fails that wait first.
- **The flow pins 16, 736, 768 and the slot's gutters as literals** — a test that read them from
  the source would follow a regression instead of failing on it.
- **`cn` and template literals side by side** — `chat.tsx` and `composer.tsx` never import `cn`;
  each file matches its own style.
- **`ExchangeCard`** — the name predates this branch; the diff changed its class only.
- **The Question's interior stretch** — `Card` lays its children out in flex and grid, which stretch
  across whatever width the card has; the cap changed the width alone, and the spec's revision note
  scopes the flow to card-against-box and text-against-column.

---

Found by the review passes on this branch (simplify, no-comments, code-review). All that the branch
introduced is fixed on the branch; the pull request does not wait on the entry.

# Deferred fixes from the reviews on every kind of file in a message

Three reviews of `feat(chat): every kind of file in a message` — `/simplify-code`'s four passes, the
comment pass, and `/code-review`'s two axes (the repo's standards, the ticket with its parent spec) —
between them found one design cleanup too wide for the branch's own pass, filed below. Everything
else is applied on this branch: one intake for a pick, a paste, a drop and a share; one download
path; one read and one draw path for a thread's media; the caps, the steer split, the
plugin-advertised availability, the widened route and the grammar's drift guard; and the
`MIN_PLUGIN_VERSION` bump to 0.80.0, the plugin version whose route first served any file a message
carries.

Declined rather than filed, with their reasons: a shared cross-artifact types table
(`plugin/media.py` as the truth, `media-parts.ts`, `media-kind.ts`, `mock-hermes.mjs` as mirrors) —
`scripts/test-media-types.mjs` parses the plugin's own map and fails the gates on drift, so the copies
cannot silently disagree, and one JSON shipped in three runtimes is a bigger change than the drift it
prevents; the bounded object-URL caches ship without profiled numbers because they bound memory
lifetime rather than speed, and `stream-writes` and `idle-requests` guard the budgets they touch;
deleting the `image-viewer` flow was correct rather than scope creep, since it tested the in-thread
lightbox this feature replaced with the platform's own viewer.

## Risky

### 1. A queued steer's marker text is re-parsed out of the queue item's own request body

`plugin/outbox.py`'s `steer_text` recovers the `<attachment>` marker lines a queued steer will carry
by re-reading the request body the app composed (`_item` → `_files` → `_body_text`), because the item
stores the send as the wire request and the attachments as metadata, not the composed text itself.

- Cost: the app's wording and the plugin's recovery of it are coupled through the request body's
  shape, so changing the marker sentence in `attachment-text.ts` moves a test in `plugin/tests` that
  reads it back through JSON, and a reader of `outbox.py` cannot see where the text came from.
- Suggested fix: let the queue item carry the composed steer text directly — a field beside
  `attachments` — so `steer_text` reads what the app wrote and `_body_text` loses its re-parse.
- Why it is not applied here: the pairing is load-bearing today (Hermes hands an unread steer back
  as the text the model read, and `requeueSteer` recovers the attachments from it), so the field is a
  contract change across the app, the plugin and the stored shape of every queued item — a
  workflow-feature task, not a cleanup this branch's review pass could verify alone.
- Why it is risky: an item queued by an older app must keep steering correctly against a newer
  plugin and vice versa, so the new field has to fall back to the body re-parse for as long as old
  items can exist.

---

# Deferred fixes from the review passes on the centred header's edge

A cleanup review of `fix(chat): hold a centred header's actions on the row's right edge` (four
parallel reviewers: reuse, quality, efficiency, altitude; then a comment pass and a two-axis code
review) turned up two changes too wide for this branch. Everything else is applied on this branch:
the last-button measurement both flows carried inline — already drifted between them, a `<= 2`
two-sided tolerance in one and a `< 4` one-sided `+1` in the other — is one `readHeader` in
`lib.mjs`, a locator's own row read in a single measure so every box and scroll width sits on one
frame, asserted so a header without a title or an action fails by name instead of as a null; the
actions div joined the row's `data-slot` contract instead of being walked as `lastElementChild`;
the thread flow's gate matches the session's; the `screens` row in `docs/e2e-flow-audit.md` now
carries what the strengthened legs assert; and the `/no-comments` pass then cut the component's
comment back to its prop contract — its old "exactly 768px" case was wrong (full-pane 768 leaves
each flank 178px), and the geometry that prose described is carried by the flows' assertions now,
not by sentences nothing checked.

## Risky, pre-existing

### 1. A drawer's heading centres inside the room its close button keeps

`popup.tsx`'s `PopupHeader` reserves `pr-14` for the drawer's close button and `PopupTitle` centres
in every form, so a drawer-form heading sits ~28px left of the popup's own centre at every width —
the same drift class this branch fixed in `ChatHeader`, reached by asymmetric padding rather than an
`auto` track. Overflow is already handled (`max-w-full truncate`), so only the drift half applies.

- Cost: every drawer form's heading is visibly off-centre beside its close button, and the component's
  own docstring claims the heading is "centred in every form".
- Suggested fix: reserve both sides (`pl-14` alongside `pr-14`) so the centring is real, or
  start-align drawer headings, which is what Material side sheets — cited in that docstring — do.
- Why it is not applied here: `popup.tsx` is untouched by this branch and the two fixes disagree
  about what a drawer heading should do, so the choice belongs with whoever owns the popup's design.
- Why it is risky: `PopupHeader` renders above every sheet, drawer and menu in the app; a padding
  change moves every pop-up's heading at once and no flow measures a drawer heading's centre today.

## Not entries

Declined with the evidence, each for what it is:

- **Hoisting the actions div's `className` into module constants** — the efficiency reviewer's own
  figure was one memoised `twMerge` over three short strings per header render, sub-microsecond, and
  the row above already calls `cn()` the same way; two constants would trade that for indirection.
- **Measuring the actions div by its new `header-actions` slot instead of its last button** — the
  div hugged its content after `justify-self-end`, but a div's right edge is trivially the row's when
  it stretches, which is the exact false green this branch removed; the last button inside the slot
  is the invariant, so the helper measures that.
- **A named constant for the `2fr` middle track** — the string has one consumer; the flows now
  assert what its split does (the title ellipsizing in its room, the flanks still holding the
  actions), and its rationale rides with the commit that chose it rather than as prose about widths,
  which is the class of claim that rotted. `COLUMN_BOX` lives in `layout.ts` because two files read
  it.
- **Exporting `centre` for two call sites** (speculative-generality read) — strictness is what it
  buys: each flow's own copy read `?? 0` for a missing box, so a header with neither title nor row
  compared `0` against `0` and passed. One strict line is the false green's fix, and the shared
  `centred` set became its only consumer, so it needs no export at all.
- **Swapping the flanks' `1fr` for `minmax(0,1fr)`** (the code review's latent-defect read) — `1fr`
  carries an auto floor, so a flank never shrinks below its controls: when a flank's share stops
  covering the actions the title drifts by the few pixels this PR already documents as its limit,
  while `minmax(0,1fr)` would pin the title exactly and spill the controls toward it instead. It
  cannot fire today either way: the floors total 186px (44px back + 118px actions + 24px gaps)
  against the narrowest real row of about 356px, and the tightest room the flows now measure — the
  session beside Code's list at 1280px — leaves each flank about 139px, clear of the 96–118px
  cluster. The spec conditions exact centring on a flank's share covering its controls, which `1fr`
  honours exactly; the swap trades the documented drift for an unfired failure mode of its own.
- **Moving the `2fr` rationale from the commit body into a comment** — the code review's own note is
  that the file is under-, not over-commented; the comment that stays explains the empty `md`+
  spacer box, which reads as a mystery div without it, while a width claim in prose is what needed
  correcting twice already.

---

# Deferred fixes from the reviews on switching chats without flicker

Two review passes over `feat(chat): hold the chat until its answers are in` and the three tickets
under it — `/simplify-code`'s four parallel reviewers (reuse, quality, efficiency, altitude) and
`/code-review`'s two independent passes (the repo's documented standards, and the ticket with its
parent spec) — turned up three findings worth recording rather than applying. Everything else both
reviews found is applied on this branch: the swap fade plays per pane rather than over the whole
screen (a thread opening beside Main no longer re-fades the unchanged pane), an answered gone chat
lands as gone with its own list's title, the thread lane refuses to read an unanswered list as "No
threads yet" and holds the previous frame inert while the list is unknown, one thread list's answer
feeds every memo that maps it, the frame is built only where it is drawn, the switch tests read one
harness, the flow samples a switch by the pane it swaps on both lanes, and 237 narration lines are
gone from the branch's files.

## Careful

### 1. The thread lane draws the previous thread live while the owners read is unknown

The lane's empty state now waits for the thread list to answer (this branch's fix), but while a
thread's *owners* read is still unknown the lane can stand on the previous thread's own instance,
mounted and live, until the addressed thread remounts over it — the beat the inert hold covers on
the main pane, uncovered here.

- Cost: for that beat the lane's composer and buttons belong to the chat the address has left
  (story 3's "nothing I do can reach the wrong chat", narrowed to a window only a read's latency
  opens); the flow's frame sampler cannot see it, since a live old pane still draws old frames.
- Suggested fix: gate the lane's content on the owners answer the way its empty state now waits
  on the list — hold `heldFrame("thread")` inert while the read for the addressed chat is unknown
  and mount the addressed thread only when the read lands.
- Why it is not applied here: it re-times the lane's mount for every navigation onto a thread,
  which is a second decision beside this branch's switch path, and the window's length is the
  host's own read. It wants the laptop switch legs sampling for inertness (the flow asserts
  frame *content* today) before the gate is trusted.

## Rejected, with the evidence

### The hold should keep the outgoing pane mounted instead of storing its element

The altitude pass proposed replacing the stored-frame hold (`src/lib/chat-hold.ts`) with the
outgoing pane kept mounted behind the arriving one, unmounted when the swap lands. The spec's
solution is written the other way round — the pane's children kept as one element and removed when
its chat is ready (`docs/specs/switching-chats-without-flicker.md`) — and a kept-mounted pane
would keep its queries, timers and composer running for a chat the address has left, which is the
interactivity the hold exists to end. The stored frame answers both (inert, and no second live
chat) with less machinery.

### Home to chat no longer slides

The spec pass read the navigation guard as silently dropping the transition between the unstarted
home and a chat. Verified: the guard fires exactly where the spec retimes a chat switch — "the
navigation into a bot or thread switch is silent", with the fade playing at the swap instead —
and home to chat *is* such a switch under the spec's model (the held hero frame is the outgoing
chat). Back to home still fades through the swap; the first open of a chat is silent by the same
rule that keeps the first send quiet. The slide it replaces is the transition the spec retimed.

---

Found by the `/simplify-code` and `/code-review` passes on this branch. It was a cleanup and a
spec-compliance review, not a bug hunt — and neither entry blocks the pull request.

---

# Deferred fixes from the reviews on thinking in a sheet

Three review passes over the branch that puts a reply's thinking in a sheet — `/simplify-code`'s
four lenses (reuse, quality, efficiency, altitude), `/no-comments`, and `/code-review`'s two axes
(the house standards and the spec) — found two cleanups too wide for this branch's pass, filed
below. Everything else they raised is applied on the branch: the row drawn as a first-class pending
state instead of a fabricated empty run, so nothing empty ever becomes a run and the status row has
no sheet to open; the rows a reply draws decided once in `lib/thinking.ts` as `thinkingRows`; the
sheet handed its scroll element over by ref instead of being reached through a `data-slot` string;
one effect over the sheet's body, gated on a run that can actually follow, the listener registry and
its false premise gone with it; Dexie v23 filtering the row it retires and every save taking the
retired key back out of the row it puts; `aria-haspopup="dialog"` naming what the row opens while
`aria-expanded` keeps saying whether it is open, and the row and its spinner labelled "Thinking…"
rather than the spinner's default "Loading"; the e2e's `lastReply` polling the compound index
instead of fetching and sorting the whole conversation; and in the tests, rows found by slot whatever
shape they are, one tap-and-read helper replacing ten copies, one `shutSheet` in the kit replacing
two, the fold switch's retirement asserted directly, de-switched titles in thread rendering, the
sheet's "whole run drawn" asserted through one helper with one tolerance, and the wheel-stop leg
tightened to prove follow against arriving words (the mock run given paragraphs enough to allow it).

Declined rather than filed, with their reasons: dropping `aria-expanded` now that the row opens a
dialog — `expanded()` in `scripts/component-kit.tsx:259` reads that attribute as *the* row-open
signal in `test-live-span.tsx:131,184,217` and `test-thread-rendering.tsx:350,397,433`, six
assertions the removal would rewrite, and `aria-haspopup="dialog"` + `aria-expanded` is the standard
popup-trigger pair rather than a disclosure left behind; reverting `test-appearance-switch.tsx` to a
pure fold-switch test as scope creep — the navigation-shortcuts coverage it carries is valid, and
what it lacked (an assertion that the fold switch stays gone) is now there; extracting a shared
sheet component from the two rows — both spell `Popup`/`PopupContent`, the library composed twice,
while the contents differ (a markdown body with a measuring ref versus stacked pop-ups), so the
wrapper would alias two lines behind a prop that hides them; and replacing the `drawn` latch with
`Popup`'s open-change callback — `drawn` is the body *mounting*, when measuring can begin, and the
callback is the open *animation ending*: different signals, and the follow starts at mount.

## Careful

### 1. Two owners for "the model is quiet now": `thinkingRows` for the row, `describeActivity` for the header

The branch gave the row's question one home — `thinkingRows` (`app/src/lib/thinking.ts:177`)
decides which stretches of a reply draw as rows, and `message-item.tsx` draws only what it returns.
The session's question still has its own copy: `describeActivity` (`app/src/lib/format.ts:37`)
returns `"Thinking…"` from two branches of its own — runs with no content, or the last call sitting
at the end of the content — and its two readers are the chat header's subtitle
(`app/src/routes/chat.tsx:502`) and, suppressed while a row can say it, the thread's status line
(`app/src/components/chat/message-item.tsx:622`).

- Cost: one rule held in two files that must agree by hand. `describeActivity` only speaks when
  `runsOf(message)` has rows while the row draws before any run exists (the pending state), so the
  copies already answer differently by design, and the next edit to either can move them further
  apart — nothing exercises both surfaces together.
- Suggested fix: make `describeActivity` return a structured activity (`{ kind: "thinking" |
  "writing" | "waiting" | "tool" }`) and let the header pick its words from it while `thinkingRows`
  stays the row's rule — or the smaller step, have its two `"Thinking…"` branches take
  `thinkingRows(message).length > 0` so one predicate answers both.
- Why it is not applied here: `lib/format.ts` and the header path are outside the files this branch
  touched, and the header reading "Thinking…" while a turn thinks is a standing product decision —
  reshaping the describer's return type moves every consumer in one commit, which belongs with
  whoever next changes the header.
- Why it is risky: the footer's suppression at `message-item.tsx:622` is derived from what rows
  exist; if the describer changes shape under it, the footer has to move in the same commit or it
  starts saying "Thinking…" beside the row again.

### 2. `t.status === "running"` is spelled by hand wherever a running call is asked about

The test for "a call is running" has no home. It is written out at `app/src/lib/format.ts:40`
(`findLast` — which running tool), `app/src/components/chat/message-item.tsx:549` and
`app/src/lib/thinking.ts:198` (`some` — whether one runs), `app/src/components/chat/tool-group.tsx:251`
(`some`), with `app/src/components/chat/approval-card.tsx:32` spelling the finder again and
`app/src/lib/tools.ts:91` folding the same comparison into a count.

- Cost: four sites can disagree about one fact — a finder and a boolean answering the same question
  in two shapes — and a change to what "running" means (a status renamed, an intermediate state
  added) is a find-and-replace across the chat's render path with nothing to fail if one is missed.
- Suggested fix: `isRunning(tool)` in `app/src/lib/tools.ts`, which already owns tool-call semantics
  and already writes this comparison (`tools.ts:91`); the finder sites become
  `.filter(isRunning).at(-1)`, the boolean sites call it directly.
- Why it is not applied here: three of the four spellings predate the branch, and the extraction
  lands in `lib/format.ts` and `lib/tools.ts` — files this branch never opened — while the
  finder/boolean split means both shapes have to move at once to be worth it.
- Why it is risky: low, but `lib/tools.ts` and `lib/format.ts` are read by every card that draws a
  call, so each consumer's call is checked rather than bulk-swapped.

---

# Deferred fixes from the reviews on the notification settings

Four review passes over the branch that gives every notification type a name and puts its Android
switches in Android's own screen — `/simplify-code`'s four lenses (reuse, quality, efficiency,
altitude), `/no-comments`, `/code-review`'s two axes (the house standards and the spec), and a
second pass over the fixes those raised — turned up one change too wide for this branch's pass,
filed below. Everything else they raised is applied on the branch: the registration universe
intersects what the device can reach, so a phone without Meetings is never registered for its two;
the phone is read once per pass and the result feeds the registration and the deferred PATCH alike;
each channel is written once a launch from `channelPlan`, a held channel keeping the importance the
phone reported and only an unheld one taking the row's default; channel provisioning is keyed on the
Meetings flag so a flip mid-session provisions what it just made reachable; the three-second pass
reads the phone when it fires and queues behind an in-flight PATCH instead of dropping its read;
`tellRegistry` is the one copy of call/throw/record; `setCategories` writes its preference where
something still reads it (the web); the settings row's tap checks the plugin is there before
calling and toasts what a real refusal says; the row chrome is one `ActionRow` shared with
`LinkBotRow`; the tautological constant test renders the row and the screen instead; and the test
harness, the source-read helpers and the sixteen-row table each stopped carrying two copies of
what one owns.

Declined rather than filed, with their reasons: gating `/settings/notifications`'s list on Android
— the spec chose "the route is not linked from anywhere", so a deep link is the accepted hole;
moving the manifest's default channel id back to `sessions` — the spec deletes that channel, so
the id had to follow the new test channel or go stale, which is recorded as a deviation in the pull
request instead; converting the wiring's text-pinned tests into injected seams — text-pinning is the
repo's parity pattern (`plugin/tests/test_push_kinds.py`), and the `changedList`/`tellRegistry`
extraction already gave the rules a seam their own tier can drive; and `enableNative` reading the
permission twice — its prompt/timeout steps are named deliberately, so the "one read a pass"
invariant is scoped to the sync paths and the test says so.

## Risky

### 1. The platform and Firebase flags freeze at module load, so every native test is an import-order dance

`isNative` (`app/src/lib/native.ts:11`) and `pushAvailable`/`nativeConfigured`
(`app/src/lib/push.ts`) read `Capacitor` and `VITE_FIREBASE` once when their module is first
imported, and nothing can re-read them. This branch's component tests had to work around that:
`scripts/android-bridge.ts` installs the platform fake and plugin headers *before* the app's modules
load, each test sets `__HERMES_ENV__.VITE_FIREBASE` itself ahead of a dynamic import, and the
stale-APK case needs a whole file of its own (`test-notification-settings-row-stale-apk.tsx`)
because a header removed after load changes nothing. `/no-comments` flagged the freezes outright
(`MUST KILL` on `androidBridge` and `pushAvailable`).

- Cost: an invisible ordering contract no lint knows — the next native test must import the fake
  first, set the flag second, and load the app third, or it silently tests the web build; and a
  page that boots before Firebase is configured can never see push become available without a
  reload.
- Suggested fix: make both flags call-time reads (a function, or a getter over the Capacitor
  handle), so `isNative()` and `pushAvailable()` answer for the state the page is in now and the
  harness configures a variant instead of racing the import.
- Why it is not applied here: both freezes predate this branch (`git blame` lands on the share
  target and the original push wiring), and every web/native branch in the app reads them —
  chat's sharing, the routes' guards, `startPush` — so converting them is a shared-infra change
  whose blast radius is a screen-by-screen sweep, not a settings cleanup. The harness now
  parameterizes the dance rather than undoing it, which removes the trap without touching the
  product.

---

Found by the `/simplify-code`, `/no-comments` and `/code-review` passes on this branch. They were
cleanup and conformance reviews, not a bug hunt — the two defects they did turn up (the registration
universe ignoring reachability, and importance being re-written on every resume) are fixed above
rather than deferred, and neither the entry nor the deviations block the pull request.

---

# Deferred: classifying a `tool_call`-wrapped call while it streams

Recorded by the design session behind `docs/adr/0053-a-card-is-drawn-only-where-a-subagent-was-set-to-work.md`:
the classifier it adds reads a call's arguments where they are in hand — the transcript for stored
rows, Hermes's control previews for the live stream — but a call sent through Hermes's `tool_call`
bridge exposes neither while it streams. The live projection sends the tool name `tool_call` and the
inner call's preview text; the inner tool's name arrives only in the transcript, where
`describeCall` (`app/src/lib/history.ts`) unwraps a single inner call onto the row. So a wrapped
`delegate_task` spawn draws as a plain tool row while it streams and as its agent card once
catch-up rebuilds the turn — the opposite direction from the bug ADR 0053 fixes: work that ran is
briefly hidden, never work that didn't.

## Careful

### 1. The stream never names the tool inside a `tool_call` bridge

- Cost: while the stream runs, a wrapped spawn's card is missing and the agents poll — now gated on
  the classifier — reads the row as no delegation, so both wait for catch-up. The wrongness is
  bounded: reclassification is authoritative the moment the turn is rebuilt, and nothing false is
  ever drawn.
- Suggested fix: either have the host's run projection carry the inner tool's name for bridge calls
  (`gateway/platforms/api_server_runs.py` in Hermes core), or unwrap `tool_call` in the live ingest
  the way `describeCall` does — but the live event carries only preview text, so the app-side
  version means inferring the inner tool from a label, which ADR 0053 rejected as the primary
  signal.
- Why it is not applied here: both routes sit outside the change — one is a Hermes-core projection
  edit (the ADR deliberately stayed client-side so any host version works), the other is the label
  heuristic the decision rejected — and the row self-heals at catch-up, so neither is worth
  contradicting the ADR for a row-instead-of-card that lasts one rebuild.
- Why it is risky: low. The classifier's default (unknown → tool row) is exactly what draws it; a
  fix must not flip that default back toward a card.

---

Found by the design session for the agent-card classification change (ADR 0053). It does not block
the pull request.

# Deferred: a pull request row stored before the stamp reads *Used a tool*

## Not entries, but recorded: the wording a pre-change row loses

A `pull_request` call stored before this change carries no `action` stamp, and its streamed label was
*the call's title* — the words of a pull request, not an action. The word table reads only a stamp or
an action its own label names, so that row now draws **Used a tool** where it drew *Opened a pull
request* before. Every such row gains its real words on the run that follows it (catch-up re-reads
the path from the transcript), and no row is rewritten: the wording drift lasts as long as the old
rows do, and only for the calls whose label was a title.

- Cost: a past chat's pull request rows read less specifically than they did, until a host rescans
  them. Nothing claims work that didn't happen — the sanctioned fallback (ADR 0053's
  fail-toward-the-row default) — so this is a loss of colour, not of truth.
- Suggested fix: none in the app. A backfill would have to guess an action from a title, which is
  exactly the claim the decision refuses; the plugin could send `action` on the preview, but that is
  a host change this branch deliberately doesn't ask for.
- Why it is not applied here: the alternative — reading *Opened* from the name — is the bug this
  change removes.

---

Found by the review pass on the agent-card classification change (ADR 0053). It does not block the
pull request.

---

# Deferred fixes from the review passes on the Compaction divider

Four review passes over `fix(hermes): draw the Compaction divider on every device` — code reuse,
code quality, efficiency and altitude — turned up two changes too wide for this branch. They are
recorded here instead of applied: each needs a schema or a wire contract this branch doesn't own.

Everything else the four passes found is applied on the branch rather than filed. The real defect
among them: `_in_place` probed for the `messages` *table* but queried the `_compressed_summary`
*column*, inside the rotation walk's own `try`, so a store from a Hermes predating in-place
compression answered `None` for the whole route — silently losing the rotation marks that worked
before this branch, since the app reads `None` as "unknown" and keeps what it has. The probe is now
`PRAGMA table_info(messages)` on the column, the in-place read has its own
`try/except sqlite3.Error` logged at warning, and a test pins a pre-in-place store keeping its
rotation marks. Beside it: the per-session `SELECT` in a loop (bounded by `COMPRESSION_DEPTH`, 1000)
is one `IN (...)` query, the duplicated `lineage`/`walked` lists are one list, the two mark shapes
are two lists merged after sizing rather than one list probed with a `""` sentinel key, the plugin
tests' positional seven-tuples are one `message()` builder, and the component test now calls
`seedChat`, `until` and `findAll` from `component-kit.tsx` instead of re-spelling them, dropping the
label regexes and `items > 0` premises that `test-compaction-divider.tsx` and `test-compactions.mjs`
already own. Placement also moved onto the host's own row time (`hermesAt`, falling back to
`createdAt`), since `history.ts` floors `createdAt` forward on catch-up and could push a divider a
row early — the millisecond mirror `_ms` stops being the only thing holding that line.

## Careful

### 1. An in-place compaction's divider carries no size

`plugin/compactions.py:78` sizes only the rotation marks: `_sizes` is keyed by session id, and an
in-place mark has no session of its own to name, so the default compression mode draws a bare
`Compaction` divider forever while a rotated host still says `168k of 200k`. The figure is not
unknown to the system — `plugin/context.py` upserts it on every call — but the `context` table's
primary key is `session_id` (`plugin/store.py:126`), so each call overwrites the pre-compaction
number before anything can read it.

- Cost: the divider's main signal is missing on the path most hosts actually run, and differs by
  Hermes config; a reader can't tell a 15k compaction from a 190k one where it matters most.
- Suggested fix: capture the size where the compaction happens rather than deriving it later — a row
  per compaction (a `compaction_sizes` table, or `context` keyed by session and time) written by the
  `post_api_request` hook when that session's summary count moves, the previous call's
  `prompt_tokens` being the context just before.
- Why it is risky: a schema plus a hook on the host, which has to stay correct while the app is
  closed, so it is plugin work with its own migration and its own tests — a task, not a cleanup.

### 2. Placement infers the row from a timestamp instead of being told it

`app/src/lib/compactions.ts:28` finds the divider's row by comparing times, which is why both the
plugin's millisecond rounding (`_ms`) and the app's `hermesAt` fallback exist: two modules encoding
one comparison rule across two languages. The plugin reads the transcript and already knows which
row is the summary, so it could name the first row written after it outright.

- Cost: any drift between the two encodings silently misplaces a divider, and the rounding rule has
  to be re-justified at every new caller. The current pair is correct and proven against a copy of a
  real store, but it is agreement by convention rather than by construction.
- Suggested fix: have the route answer the summary's row id and have the app match it against
  `hermesRowId` (`h-<session>-<row>`), making placement exact rather than approximate.
- Why it is risky: it changes the `compactions` wire contract, so it needs a plugin version, an
  older-plugin fallback to the timestamp path, and the app's own migration of stored marks.

## Not entries

- `compactions.read` still carries its own copy of `sessions.chat_session`'s lineage walk (the
  duplication predates this branch, blame `02d3925c`). A single `_lineage()` in `sessions.py`
  returning the walked path would serve both callers and keep the fork rule in one place — worth
  doing the next time that walk moves, not from a cleanup pass over an unrelated change.
- A rotated chat reports its compaction once, not twice: the child a rotation hands off to carries
  the rotation's own summary, flagged `_compressed_summary` like an in-place one, and reading it as
  a second compaction was believed to cost bytes rather than pixels (two marks in one gap collapse
  to one divider). It cost pixels. The app keeps the *first* mark of a row, the summary row is
  written before the parent is closed (`hermes_state_compression.py` inserts the child's rows, then
  ends the parent), so the size-less in-place mark sorted ahead of the rotation mark and won the
  row: a rotated chat's divider went from `Compaction · 168k of 200k (84%)` to a bare `Compaction`.
  Fixed in the plugin — a summary in a session the walk continued into counts only after the moment
  its parent ended — with `test_a_rotation_summary_is_that_rotation_not_one_more` and the fixture
  case in `test_in_place_marks_and_a_rotation_merge_oldest_first` holding both sides.

---

Found by the four review passes on the Compaction divider change. The defect they turned up (the
column probe above) is fixed on the branch; the two entries above do not block the pull request.

---

# Deferred: what the review pass on the archive drain left

Three passes ran over `feat(chat): load a compacted chat's archive at the thread's top`
(simplify-code's four lenses, `/no-comments`, and `/code-review`'s two). What they found is applied on
the branch, with the three exceptions below.

The constant was the multi-page drain. Four lenses independently read `pages.push(kept)` as stacking
pages newest-first, and they were right: each page of a display read is returned oldest-first, so the
page read first sits nearest the window and every page after it is older. The archived stretch came
back reversed in blocks of 500. Nothing caught it because the flow that walks the archive seeded fewer
rows above the seam than one page carries: the mock now writes 600 rows above it, and the flow asserts
the order they come back in — which fails on `push` and passes on `unshift`.

## A reply the device streamed, and the walk that replaces it

`held` is built from the rows this device's messages name (`hermesRowId`). A reply that is still
streaming names no row, so a reach running while a turn is in flight can write a second copy of it —
which is why the edge is armed on a chat's first catch-up only, and why `test-subagent-result.tsx`
turns red if that arming widens to every catch-up. The deeper fix is for `held` to know the row an
in-flight reply stands in for, which wants a streaming reply to carry the row it will become; the host
doesn't send one, and inferring it from the turn's position is the content matching ADR 0058 rejects.
Cost: a reach during a streaming turn can duplicate its reply, and the catch-up that follows replaces
it. Suggested fix: none here — it wants the host to name the row.

## `loadEarlier` is still one long function

It carries the ask, the two numberings, the page loop, the cut-turn mend and the write. Splitting it
into `walk` / `mend` / `write` was the loudest quality finding, and the split that reads well is the
one that takes the cursor as a value and returns the next — which is `history-window.ts`, and it is
done. What is left is a loop over that rule, and each of its three behaviours has a test that fails
without it; splitting further would trade one long function for four that each take six arguments.

---

Found by the review pass on the archive drain (ADR 0058). None of it blocks the pull request.

## A Stop's one clock, and the waits that mirror the host

Found by the review pass on the cleanup levels (ADR 0066). None of it blocks the pull request.

### 1. A Stop spends one clock on the pieces and the cleanup

`settle()` (`src/lib/dictation.ts`) takes one deadline: the pieces still being heard drain against
it, and `tidy()` is then given `deadline - Date.now()`, the remainder. `STOP_WAIT_MS` is 12 s and
the host's High cleanup is bounded at 12 s of its own, so a take whose last piece was still in
flight at Stop cannot fit the cleanup in — the client stops waiting and lands the heard words,
while the host's `_within` worker runs the model call to its own deadline and throws the answer
away.

- Cost: at High, the level that costs the most tokens is the one a Stop most often loses, and every
  lost one is a full model call paid for and discarded. The coupling predates the levels (it was 8 s
  against 8 s), so this pass corrected the comment that claimed 12 s "covers the widest budget a
  host holds for a cleanup" rather than the clock.
- Suggested fix: give the cleanup its own window — start its budget when the drain finishes and cap
  it at the level's deadline — or raise `STOP_WAIT_MS` to the drain allowance plus the widest
  deadline. Both are product-visible waits, so they want the user's call rather than a cleanup pass.

### 2. The client copies the host's per-level deadline

`SEND_WAIT_MS` and `STOP_WAIT_MS` are the client's statements of a budget that lives on the host
(`dictation_cleanup.LEVEL_FACTS[level].deadline_s`, per level). The client is handed `config`, not
the speech settings, so it cannot read the level it is racing against.

- Cost: a fifth level or a changed High deadline is a two-repo edit with nothing to fail when one
  side is missed.
- Suggested fix: let the host state its own bound — a `cleanup.deadline_ms` on the speech record, or
  on the cleanup's answer — and derive both waits from it.

# Deferred: one chat-next test flakes, and the invariant behind it is unenforced

`app/scripts/test-chat-next-older.tsx`'s "a thread left unfinished picks up where it stopped, from the
rows the device holds" fails about one run in four or five, on `assert.equal(await
database.sessionRows.count(), 2 * PAGE, "it was not written for nobody")`: 180 rows land where the page
already written is 100. It is not this branch's: with `app/src/chat-next/fold.ts` and
`app/src/chat-next/state.ts` checked back out from the merge-base it still failed, 1 run in 5, and
neither that test file nor `chat-next/page.tsx` is touched here. It reds the app's gates on whichever PR
runs first, and a re-run clears it.

## Risky

### 1. Nothing decides whether a page that lands as the device closes is written

- What is known: the walk is `page.tsx`'s `readOlder` loop, which stops when `olderRun.current` moves —
  `stopOlder` bumps it, and the device's unmount calls it beside `alive.current.abort()`. Yet a run
  sometimes writes every remaining page after the close. Which side wins is timing: the abort's rejection
  and the page's own resolution race, and the assertion says the wrong one sometimes gets there first.
- Cost: the invariant the assertion guards — a closed device is not written for nobody — is only checked
  by a test that fails on its own now and then, so nobody trusts the red; and a flaky gate costs every
  PR a re-run.
- Suggested fix: one answer for "this run is over", checked where the page is applied rather than after
  it is awaited, and a test that waits on that answer instead of `wait(50)`. It needs its own probe: which
  of the abort and the resolution is observed first, at the sizes `LONG` uses.
- Why it is not applied here: it is a paging race in code this branch never touches, and a fix needs the
  timing proven before it is written — not guessed inside a progress-reminders review.

# Deferred: both screens read liveness off a row, so a run the host lists can read as no run

The steer offer is now honest on chat-next: `canSteer` is the screen's capability and `busy` is the
only liveness fact, so a run the host lists offers its steer whether or not the page has joined its
events (`chat-next/page.tsx`, the `steer-offer` flow). The current screen (`routes/chat.tsx`,
`CurrentChatPage`) still answers liveness from the device's own streaming row — `busy =
Boolean(streaming)` (`:850`), where that row is written only when `adoptRun` has caught the
transcript up (`lib/chat.ts:1264-1304`) — and takes `steerable` from that row's `runId` plus a
`/capabilities` probe (`:919`). A run the host lists but this device has not adopted therefore reads
as no run: the field says `Message …` and Enter starts a fresh run beside the live one. chat-next's
`busy` has the same shape (below), though its offer no longer waits on the join.

- Cost: the two screens answer "is a reply running" differently for the same host state, so the bug
  class this branch fixed survives on the screen most builds open; sending during that window posts a
  concurrent run instead of steering or queueing, which is what the plugin's queue exists to avoid.
- Suggested fix: feed that screen's `busy` from the shared rule the rest of the app already uses —
  `runFinished({ live: runStatus, local: { streaming: busy }, subagents })` (`lib/session-work.ts`,
  as `chat.tsx:1088` does for `runLive`) — and let `steerable` stay a capability. That also moves Stop,
  `activity` and the thread's look at a handover, so it wants its own branch and a flow that opens a
  session mid-run on the current screen.
- Why it is not applied here: it changes what the composer, Stop and the activity line do on the app's
  busiest screen, and this branch's flow covers chat-next only; doing it half-way would leave the two
  screens disagreeing in a third way.

chat-next has the same shape in `busy`: `doing.running || Boolean(hostRunId && !last?.done &&
!last?.failed)` (`app/src/chat-next/page.tsx`) reads `last` as the device's own last turn, so a
session returned to that already holds the previous finished turn reads idle while the host lists a
run — measured on the component harness (`host.hold(0)` + `host.startElsewhere` after one finished
turn): the field read `Message A bot…` for 3s, Enter opened a second run beside the live one, and no
steer row was written. The offer above is fixed either way; what is not is the liveness half.

Found by the simplify pass (altitude and reuse reviewers, converging on `page.tsx`'s two liveness
facts) and by the review's spec axis, which probed the chat-next case; it does not block that fix.

## A photo a message named by address is dropped, not drawn

`splitAttachments` reads `[Image attached: <url>]` as part of the host's trailer and drops it, so the
line stops reading as the user's words — but nothing draws the photo behind it: `Attachment` carries a
`path` on the host, never an address, and `media-source.ts` has no remote source to hand a cell.

- Cost: a message whose photo arrived as an `image_url` rather than a file shows neither the words nor
  the image, where before it showed the host's handle as its text. The path form, which is what this
  app's sends produce, is drawn.
- Suggested fix: give `Attachment` a `url`, have `attachmentSources` pass it through, and let a cell
  draw from an address, so the fold keeps the reference instead of dropping it. Its own task — it
  changes the media-source contract, not the text fold.

## The sentence the host writes for a wordless photo still reads as the message

`restore_api_images` gives a message that carried a photo and no text of its own the words "What do
you see in this image?", and the row's text then opens with them. `splitAttachments` drops the hint
line and the placeholder but not that sentence, so a row written that way would draw a question the
user never asked.

- Cost: nothing today — every message this app sends carries a `<attachment>` marker text part, so the
  host never reaches that branch for a Gots send. The two test hosts now write that shape, so it is
  one fixture away from being visible.
- Suggested fix: pin the sentence beside the hint lines and drop it where the row carries no marker,
  the same condition as the hint-drawn photo, so a user who typed it keeps their words.

## A steer that carried a photo draws its words and no photo

Both screens fold a steer to its words (`steerWords`), and neither a `Turn` part nor a `Reply`'s
steers list carries the files it named — so a photo steered into a running reply is not drawn at all.
The classic screen has worked this way since the fold existed; this branch brings the new screen to the
same rule, where before it drew the raw marker line as the steer's text.

- Cost: a steered photo is invisible on both screens. Nothing is lost on the host — the row keeps it —
  and a reload draws the same, so the thread states the same thing twice.
- Suggested fix: give the steer part a `files` list the way a turn has one, draw it with the thread's
  own media components, and map it through `messages.ts` beside the turn's.
