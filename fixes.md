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
