# Seamless resume: tickets, in order

Goal: switching devices, or returning to the app after a few minutes away, shows the latest chats
and coding sessions without a visible catch-up. Today that takes about 5 to 10 seconds. Nobody has
measured it yet; the causes below come from reading the code. Ticket 0 exists so the rest are
judged on numbers, not on that reading.

Give an agent **one ticket per pull request**, in order. Each ticket lists what it depends on.
Tickets 5 and 6 are gated on what ticket 0 shows; they may be dropped.

## Rules for every ticket

- Read `AGENTS.md` and `GLOSSARY.md` first. Line numbers below are from the commit this spec was
  written against and will drift: find the code by the symbol named.
- Run every command from `app/` unless a ticket says plugin. Before committing: `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm build`. All four pass.
- For a change to chats, sessions, polling or sync, also run the browser flows it touches:
  `pnpm e2e list`, then `pnpm e2e <flow>` for the relevant ones. Never `pnpm e2e all`.
- A test belongs to the cheapest tier that would fail for the reason the change can fail (ADR 0019):
  unit (`scripts/test-*.mjs`, pure rule), component (`scripts/test-*.tsx`, seeded device database
  with the HTTP boundary faked), then end-to-end. Do not add an e2e flow unless a lower tier cannot
  reach the behaviour; if one is added it needs a row in `docs/e2e-flow-audit.md`.
- Plugin changes: tests in `plugin/tests/`, run from the repo root with
  `python3 -m unittest discover -s plugin/tests -t .`. Bump the version in `plugin/plugin.yaml` and
  `plugin/dashboard/manifest.json` together. Update `app/scripts/mock-hermes.mjs` to match any
  changed route. Run `python3 .github/scripts/scan-plugin.py <hermes checkout> plugin` if the
  prompts or prose changed.
- Do not add UI text that explains how the app works. Do not add a Dexie schema change where a
  non-indexed field or in-memory state will do; if the schema does change, bump the Dexie version.
- Conventional Commits, summary 72 characters or fewer. Fill in `.github/pull_request_template.md`.
  Update the `AGENTS.md` layout rows for any file whose role changes.
- Failures in background work go through `quietly` / `noteFailure` in `src/lib/report.ts`. A guard
  or lock taken at the start of an async flow is released in `finally`.

---

## Ticket 0: Time the resume

**Depends on:** nothing.

**Problem.** The causes in tickets 1 to 6 are inferred. Without timings, nothing can be shown to
have helped, and tickets 5 and 6 cannot be judged.

**Change.**
- Add `src/lib/resume-trace.ts`: a small module that, when the app comes back (the same trigger as
  `onWake` in `src/lib/wake.ts`, but with no 5 second minimum: record every return to visible),
  starts a trace and lets other modules mark stages with `markResume(stage)`. Times are
  milliseconds since the return, from `performance.now()`.
- Mark at least these stages: `stream-hello` (`onEvent` `hello`, `live.ts`), `sync-start` and
  `sync-end` (`runSync`, `sync.ts`), `account-docs-end` (after the `Promise.all` of `syncBots`,
  `syncAppearance`, `syncPrompts`), `registry-end` (after `pullRegistry`), `chats-merge-end`
  (`mergeChatList` resolves, per connection key), `runs-live-end` (`poll` in `waiting.ts`), and
  `open-chat-caught-up` (`reconcileHistory` resolves for the chat on screen).
- Keep only the latest trace per launch, in memory. Add it to the device state a bug report carries
  (`src/lib/diagnostics.ts`, `DiagDevice`): stage names and millisecond offsets only, picked field
  by field. Nothing that names a server, a chat or a message.
- Also count the requests a resume made, per stage, so duplicate syncs are visible.

**Out of scope.** Any behaviour change. No UI beyond the existing device-state copy block.

**Acceptance.**
- After leaving the app 5 minutes and returning, Settings > Developer's device state shows the
  stage offsets of that return.
- A resume that runs `runSync` twice shows two `sync-start` marks.
- No behaviour or request count differs from before the change.

**Tests.** Unit test for the trace's pure rule (offsets, latest trace wins, no marks outside a
trace). Extend `scripts/test-diagnostics.mjs` / `scripts/test-device-state.tsx` for the new field,
including that no address, key or text can ride along.

**Hand the result to the user:** record three traces on a real Android phone (5 minutes off) and one
on a laptop tab brought to the front after switching from the phone. Put them in the PR description.
Tickets 1 to 4 should be re-measured against these.

---

## Ticket 1: Sync chats first; make the account documents lazy

**Depends on:** ticket 0 (for the before and after numbers).

**Problem.** `runSync` (`sync.ts`) is one serial chain: `ensureInbox`, then `syncBots` +
`syncAppearance` + `syncPrompts`, then `pullRegistry`, and only then `syncChatLists`. The first
three stages are Netlify requests. Chats and coding sessions live on each bot's plugin and need no
account (AGENTS.md, Sync), yet every resume waits for all the Netlify stages first. A thrown error
in any of those stages skips `syncChatLists` entirely, so a slow or failing Netlify also delays or
blocks chat sync. The documents themselves (bots, appearance, prompts) almost never change.

**Change.**
- Split the work in `runSync` into two parts that can run independently: the account documents
  (`ensureInbox`, `syncBots`, `syncAppearance`, `syncPrompts`, `pullRegistry`) and the chat lists
  (`syncChatLists`).
- On a **wake-triggered** sync (visibility change, `online`, Android resume), start `syncChatLists`
  immediately, and run the account documents concurrently with it, only if the last completed
  account sync was more than `ACCOUNT_SYNC_MS` ago (new constant in `src/lib/freshness.ts`, start at
  60 seconds). Track that time in a module variable in `sync.ts`; do not persist it, so a fresh
  launch still does a full sync.
- A sync caused by a **local change** (the fingerprint subscriber), by sign-in, by the Settings
  "Sync now" button, or by setup always runs the account documents too and ignores the throttle.
- `pullRegistry` can add bots. If it added any bot ids that `syncChatLists` did not cover, run
  `syncChatLists` again for just those ids afterwards.
- A failure in the account documents must not stop the chat lists, and a failure in the chat lists
  must not stop the account documents. `state.error` reports the account error as it does now; chat
  list failures keep reporting through `chatStores[profile.id] = "unreachable"`.
- `state.syncing` stays true until both parts finish, and `syncedFingerprint` and `syncedAt` are
  written only after both succeed, as now.
- Keep the legacy `pullFallbackChats` path working for bots not yet in `Settings.movedChats`; it
  needs the key and runs inside `syncChatLists` as today.

**Out of scope.** Changing what the documents contain, the plugin, how often anything polls.

**Acceptance.**
- With the Netlify calls stubbed to take 5 seconds, a wake-triggered sync merges each bot's chat
  list without waiting for them.
- With the Netlify calls stubbed to fail, the chat lists still sync, and `state.error` is set.
- A wake within `ACCOUNT_SYNC_MS` of the last full sync makes no Netlify request.
- A local edit to a bot's name still pushes the `bots` document within the existing 1.5 second
  debounce, throttle or no throttle.
- A bot that `pullRegistry` adds during a sync gets its chat list merged in the same pass.

**Tests.** Pure rule for "does this trigger run the account documents" (unit,
`scripts/test-*.mjs`). Component test over a seeded database with the plugin and Netlify boundaries
faked, covering the three failure and slow cases above. Look at `scripts/test-main-triage.tsx` for
how a component test fakes the host.

---

## Ticket 2: One resume, one pass

**Depends on:** ticket 1.

**Problem.** One return to the app starts the same work several times:
- `sync.ts` calls `syncNow()` on `visibilitychange` and on `online`.
- The first `hello` from a stream with no saved cursor calls `catchUpAll`, which calls `syncNow()`
  again (`live.ts`, `onEvent`). `syncNow` while a sync runs sets `again = true`, so the *whole*
  sync, account documents included, runs a second time.
- `waiting.ts` (`pollAll`) and every `usePoll` with `onShow` also read on `visibilitychange`.
  Those are different reads and are fine; they are listed so the agent does not "fix" them.

**Change.**
- Give `syncNow` a scope. Add a chat-lists-only entry point (reuse or extend `syncChatsOf`, which
  already exists) and a full one. The `again` flag becomes two flags (`againFull`, `againChats`),
  and a pending chats-only request while a full sync is running adds nothing, because the full sync
  covers it. A pending chats-only request while a chats-only sync runs queues one more chats-only
  run, not a full one.
- `catchUpAll` (`live.ts`) uses the chats-only entry point. It keeps bumping the other kinds.
- The `visibilitychange` and `online` handlers in `sync.ts` use the same wake entry point as
  ticket 1 (chat lists now, account documents only past the throttle).
- Do not change `usePoll`, `waiting.ts` or the fingerprint-triggered sync.

**Out of scope.** Merging the DOM listeners into a single global one. That is a refactor with its
own risk and is not needed for the saving.

**Acceptance.**
- A cold return with no saved cursor produces one chat-list merge per connection, not two, and no
  second account sync.
- A chat-list request arriving mid-full-sync does not start another full sync.
- A change made on this device during a sync is still pushed (the existing guarantee `again` gives).
- Ticket 0's trace shows one `sync-start` for a resume.

**Tests.** Unit test for the coalescing rule if it can be made pure; otherwise a component test that
fires visibility, `online` and a `hello` in quick succession and counts the fake host's calls.

---

## Ticket 3: Keep the event cursor across a restart

**Depends on:** ticket 2.

**Problem.** `cursors` in `live.ts` is a `Map` in memory. When Android drops the WebView during a
few minutes away, the cursor is lost, so the next `hello` has `resumed === false` and takes the
`catchUpAll` path, a full chat-list merge plus a bump of every screen, even though the plugin keeps
an hour (2,000 rows) of events and can replay exactly what was missed.

**Change.**
- Persist the cursor per connection key (`connectionKey`), on this device only. `localStorage` with
  `try`/`catch` is acceptable, matching the read marks (`src/lib/read-marks.ts`); do not sync it
  and do not put it in the Dexie schema.
- Seed `cursors` from storage when a stream starts. Write it when it advances, at most once a
  second.
- A `hello` for a stream started from a stored cursor is a resume, so skip `catchUpAll`; the replay
  that follows is what catches up. A `reset` event still calls `catchUpAll`.
- Verify in `plugin/stream.py` and `plugin/events.py` what the server does with a cursor it no
  longer knows: lower than the oldest row (already `reset`), but also **higher than the newest**
  (the events table was cleared or the profile's store was recreated). If that case does not send
  `reset`, fix it in the plugin in this ticket, with a plugin test, because otherwise a stale stored
  cursor would silently hide changes.
- Drop the stored cursor when a connection's key or bot is removed.

**Out of scope.** Changing the events table's retention.

**Acceptance.**
- After a simulated process restart, the first stream opens with `since=<stored cursor>`, runs no
  full chat-list merge from `hello`, and still applies a `chats` event that arrived while away.
- A stored cursor older than the table's retention produces a `reset` and a full catch-up.
- A stored cursor newer than the table's newest row also produces a full catch-up.
- Storage unavailable (private window): behaves as today.

**Tests.** Component or unit test over the cursor store. Plugin test for the "cursor too new" case.
If the plugin changed: version bump in both files, and `mock-hermes.mjs` kept consistent.

---

## Ticket 4: Merge only what changed

**Depends on:** tickets 1 to 3. This is the riskiest ticket; do it after the cheap ones and only
if ticket 0's traces still show the merge request as a large share of the wait.

**Problem.** `mergeChatList` posts every local chat record, drafts and all, and the plugin answers
with every record (`chats.merge` returns `_records(conn)`), on every sync. The request and response
grow with the number of chats, for a list that usually changed by one record.

**Design constraint the agent must keep.** The `at` on a record is a *device's* clock
(`changedAt`). It cannot be the cursor for "what is new to me": a record written with an older `at`
than my last sync would be missed. The plugin therefore needs its own change counter.

**Change (plugin).**
- Add a monotonically increasing `seq` to the `chats` table in `memento.db` (new schema version with
  a migration that numbers existing rows), assigned on every insert or update that actually changes a
  row (the `WHERE excluded.at > chats.at` condition in `merge`). Keep a single counter per store.
- `POST chats` accepts an optional `since` (a seq). With it, the response is
  `{ chats: <only rows with seq > since>, cursor: <current max seq> }`. Without it, behave exactly as
  today and also return `cursor`.
- Advertise `chats_delta` in `info`'s `features`. A merge that changed nothing still must not note an
  event (the existing loop-prevention).

**Change (app).**
- Store a `since` cursor per connection key on this device, like ticket 3.
- When the plugin advertises `chats_delta` and a cursor exists, send only the local records worth
  sending: those with `changedAt` greater than the time of this device's last successful merge for
  that connection, plus any tombstone still pending. Apply the response with the existing
  `applyChats` / `mergeDocs` logic unchanged.
- Fall back to a full merge (no `since`, whole local list) when: no cursor, a plugin without the
  feature, an error reading the delta, and at least once per launch and once every 6 hours.
- Two bots on one server share its list; the cursor is per connection key, not per bot, and a chat
  stays with the bot that already has it, as today.
- **Tombstones.** `settleChatTombstones` only deletes a local tombstone when the merged list shows a
  record with the same `at`. A delta response will not contain a tombstone the server already had.
  Settle a tombstone once a merge that included it succeeds, and keep the existing rule that a
  newer remote record for that id is pulled and clears it. Write the test for this case first.

**Out of scope.** Changing the record format, draft handling, or the 64 KB record cap.

**Acceptance.**
- Second and later merges send and receive only changed records (assert on the fake host's
  request and response sizes).
- A chat edited on device A appears on device B after one delta merge; a chat deleted on A is gone
  on B and A's tombstone is cleared.
- A record written with an `at` *older* than B's last sync (clock skew) still reaches B.
- An app against a plugin without `chats_delta` behaves exactly as before; a plugin with it and an
  older app behaves exactly as before.
- A full merge after a cursor error repairs any divergence.
- `MIN_PLUGIN_VERSION` is **not** raised (the app falls back).

**Tests.** `plugin/tests/test_chats.py` for the migration, the counter and both response shapes.
Component test for the app's choice of full versus delta and the tombstone case. Update
`mock-hermes.mjs` to serve both shapes.

---

## Ticket 5 (gated): Stage the open chat's follow-up reads

**Gate.** Do this only if ticket 0's traces show `open-chat-caught-up` finishing much later than
`chats-merge-end`, and the gap lines up with the follow-up reads.

**Problem.** After 2 minutes away (`FOLLOW_UP_MS`), `reconcileHistory` fires `followUps` (title,
context, provider usage, todos, moves, workspace, library, PRs) together, alongside the event stream
and the `runs/live` poll. If the host is reached over HTTP/1.1 (some tunnels), browsers cap about six
concurrent connections per host, so these can queue behind the transcript read the user is waiting
for. This is a hypothesis; the transcript read is already not awaited by the follow-ups.

**Change.** Start `followUps` after the transcript read settles and the thread has painted (next
animation frame or `requestIdleCallback` with a short timeout), not at the same moment. Do not
change `refreshQueue` running before the transcript (`reconcileHistory`): the comment there says it
exists so a run the plugin started is followed live rather than loaded half done.

**Acceptance.** The open chat's messages arrive no later than before in every case and earlier when
the connection is contended; the follow-up reads still all happen within the same window
(`FOLLOW_UP_MS` rules unchanged).

**Tests.** Component test asserting request order against the fake host.

---

## Ticket 6 (gated, risky): Keep the stream through a short hide

**Gate.** Only if ticket 0 shows the reconnect (time to `stream-hello`) is a meaningful share of a
desktop or PWA resume. Likely no gain in the Android WebView, which may freeze while hidden. Be
prepared to close this ticket as "not worth it".

**Hazard.** The plugin skips push for a device whose `events` stream is open, because it assumes the
app is on screen (AGENTS.md, Sync: "A device that holds an `events` stream with its `device` id is
skipped"). Keeping a stream open while the page is hidden would suppress approval, question and plan
pushes for the whole grace period.

**Change.** In `reconcileStreams` (`live.ts`), do not abort streams the moment the page hides;
abort after `STREAM_GRACE_MS` (new, `freshness.ts`, 15 seconds, no more) unless the page is visible
again. To remove the push hazard, the stream must tell the plugin it is hidden (for example a
`hidden=1` query parameter on reconnect, or a small `POST` the stream's device id is checked
against) and the plugin must stop treating a hidden device as skipped. This needs a plugin change,
its test in `plugin/tests/`, and a `features` entry the app checks first. Without the plugin side
landing first, do not ship the app side.

**Acceptance.** A push-worthy event arriving while the app is hidden within the grace period still
produces a push; returning within the grace period reuses the open stream and shows no
reconnect; returning after it behaves as today.

**Tests.** Plugin test for the hidden device being pushed to. Component test for the grace timer.

---

## Done when

The traces from ticket 0, repeated after each merged ticket, show a resume that has the latest chat
list and the open chat's messages within about one second of a warm connection, and that does not
run any stage twice. If a ticket's change does not move the numbers, say so in its PR and leave it
unmerged for the user to decide.
