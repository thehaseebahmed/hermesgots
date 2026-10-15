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
