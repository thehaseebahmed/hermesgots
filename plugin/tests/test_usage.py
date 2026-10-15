"""Serializing account-usage snapshots for the app.

Run: python3 -m unittest plugin.tests.test_usage -v
"""

from __future__ import annotations

import inspect
import json
import unittest
import urllib.error
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import ModuleType
from typing import Optional
from unittest import mock

from plugin import usage, usage_ollama


@dataclass(frozen=True)
class FakeWindow:
    label: str
    used_percent: Optional[float] = None
    reset_at: Optional[datetime] = None
    detail: Optional[str] = None


@dataclass(frozen=True)
class FakeSnapshot:
    provider: str
    source: str = "test"
    plan: Optional[str] = None
    windows: tuple = ()
    details: tuple = ()


class _UnreadableSignature:
    """A fetcher whose signature ``inspect`` refuses to read, but that can still be called.

    The shape a builtin has, and the one the plugin's probe has to survive.
    """

    __signature__ = "not a signature"

    def __init__(self, snapshot: object) -> None:
        self.snapshot = snapshot
        self.calls: list = []

    def __call__(self, provider, **kwargs):
        self.calls.append((provider, kwargs))
        return self.snapshot


class TestSerialize(unittest.TestCase):
    now = datetime(2026, 10, 13, 12, 0, 0, tzinfo=timezone.utc)

    def test_drops_windows_without_used_percent(self) -> None:
        snap = FakeSnapshot(
            provider="anthropic",
            windows=(
                FakeWindow(label="Session", used_percent=42.0, reset_at=self.now + timedelta(hours=2)),
                FakeWindow(label="No data", used_percent=None),
            ),
        )
        result = usage.serialize(snap, now=self.now)
        assert result is not None
        self.assertEqual(len(result["windows"]), 1)
        self.assertEqual(result["windows"][0]["label"], "Session")

    def test_drops_past_resets(self) -> None:
        snap = FakeSnapshot(
            provider="anthropic",
            windows=(
                FakeWindow(label="Past", used_percent=90.0, reset_at=self.now - timedelta(hours=1)),
                FakeWindow(label="Future", used_percent=10.0, reset_at=self.now + timedelta(days=5)),
            ),
        )
        result = usage.serialize(snap, now=self.now)
        assert result is not None
        self.assertEqual(len(result["windows"]), 1)
        self.assertEqual(result["windows"][0]["label"], "Future")

    def test_resets_at_iso_string(self) -> None:
        reset = self.now + timedelta(hours=3)
        snap = FakeSnapshot(
            provider="openai-codex",
            windows=(FakeWindow(label="Weekly", used_percent=75.0, reset_at=reset),),
        )
        result = usage.serialize(snap, now=self.now)
        assert result is not None
        self.assertEqual(result["windows"][0]["resets_at"], reset.isoformat())

    def test_null_resets_at_passes_through(self) -> None:
        snap = FakeSnapshot(
            provider="openrouter",
            windows=(FakeWindow(label="Key quota", used_percent=50.0, reset_at=None),),
        )
        result = usage.serialize(snap, now=self.now)
        assert result is not None
        self.assertIsNone(result["windows"][0]["resets_at"])

    def test_plan_passes_through(self) -> None:
        snap = FakeSnapshot(
            provider="openai-codex",
            plan="Pro",
            windows=(FakeWindow(label="Session", used_percent=30.0, reset_at=self.now + timedelta(hours=1)),),
        )
        result = usage.serialize(snap, now=self.now)
        assert result is not None
        self.assertEqual(result["plan"], "Pro")

    def test_none_plan_omitted(self) -> None:
        snap = FakeSnapshot(
            provider="anthropic",
            plan=None,
            windows=(FakeWindow(label="Session", used_percent=30.0, reset_at=self.now + timedelta(hours=1)),),
        )
        result = usage.serialize(snap, now=self.now)
        assert result is not None
        self.assertIsNone(result["plan"])

    def test_detail_passes_through(self) -> None:
        snap = FakeSnapshot(
            provider="openrouter",
            windows=(
                FakeWindow(
                    label="Key quota",
                    used_percent=60.0,
                    reset_at=self.now + timedelta(hours=2),
                    detail="$5.00 of $10.00 remaining",
                ),
            ),
        )
        result = usage.serialize(snap, now=self.now)
        assert result is not None
        self.assertEqual(result["windows"][0]["detail"], "$5.00 of $10.00 remaining")

    def test_empty_windows(self) -> None:
        snap = FakeSnapshot(provider="anthropic", windows=())
        result = usage.serialize(snap, now=self.now)
        assert result is not None
        self.assertEqual(result["windows"], [])

    def test_none_snapshot(self) -> None:
        self.assertIsNone(usage.serialize(None, now=self.now))


class TestFetch(unittest.TestCase):
    def test_returns_none_on_import_error(self) -> None:
        with mock.patch.dict("sys.modules", {"agent": None, "agent.account_usage": None}):
            # The late import inside fetch will fail; any exception → None.
            result = usage.fetch("anthropic")
            self.assertIsNone(result)

    def test_returns_none_on_unsupported_provider(self) -> None:
        # When fetch_account_usage returns None (unsupported provider), serialize
        # returns None too.
        fake_mod = mock.MagicMock()
        fake_mod.fetch_account_usage = mock.MagicMock(return_value=None)
        with self._patched_core(fake_mod):
            result = usage.fetch("some-unknown-provider")
            self.assertIsNone(result)

    # --- the ollama-cloud fallback: core answers first, the plugin's fetcher is the net ---

    def _core_module(self, snapshot: object = None, error: Optional[Exception] = None,
                     *, takes_read_only: bool = True):
        """A stand-in agent.account_usage whose fetch answers `snapshot` or raises `error`.

        The fetch is a real function rather than a ``MagicMock``, because its signature is what
        decides how the plugin reads it: ``read_only`` reaches only a core that takes it, which
        Hermes gained after its first releases. Calls land on ``module.calls`` as
        ``(provider, kwargs)``: the keywords the plugin passed.
        """
        calls: list = []

        def answer(provider, kwargs):
            calls.append((provider, kwargs))
            if error is not None:
                raise error
            return snapshot

        def read_with_read_only(provider, *, read_only, base_url=None, api_key=None):
            return answer(provider, {"read_only": read_only})

        def read_plainly(provider, *, base_url=None, api_key=None):
            return answer(provider, {})

        module = mock.MagicMock()
        module.fetch_account_usage = read_with_read_only if takes_read_only else read_plainly
        module.calls = calls
        return module

    def _patched_core(self, module, *, has_interrupt_compat: bool = True):
        """A patched ``agent`` package around ``module``'s ``account_usage``.

        ``has_interrupt_compat`` says whether the host's core also ships
        ``agent.interrupt_compat._accepts_keyword`` — core's own answer to the same question,
        used where it exists, which reads a ``**kwargs`` fetcher as taking the kwarg. Without
        it the plugin's own probe decides.
        """
        compat = ModuleType("agent.interrupt_compat")
        if has_interrupt_compat:

            def _accepts_keyword(callable_obj, name):
                """Core's probe: a named parameter, or a ``**kwargs`` swallow."""
                try:
                    parameters = inspect.signature(callable_obj).parameters.values()
                except (TypeError, ValueError):
                    return False
                return any(
                    p.kind is inspect.Parameter.VAR_KEYWORD
                    or (p.name == name and p.kind is not inspect.Parameter.POSITIONAL_ONLY)
                    for p in parameters
                )

            compat._accepts_keyword = _accepts_keyword  # type: ignore[attr-defined]
        return mock.patch.dict(
            "sys.modules",
            {
                "agent": mock.MagicMock(),
                "agent.account_usage": module,
                "agent.interrupt_compat": compat,
            },
        )

    def test_a_core_whose_signature_cannot_be_read_is_read_plainly(self) -> None:
        """Whatever the signature probe can't read, the read still happens."""
        core = _UnreadableSignature(
            FakeSnapshot(
                provider="anthropic",
                windows=(
                    FakeWindow(
                        label="Session",
                        used_percent=12.0,
                        reset_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
                    ),
                ),
            )
        )
        module = mock.MagicMock()
        module.fetch_account_usage = core
        with self._patched_core(module):
            result = usage.fetch("anthropic")
        assert result is not None
        self.assertEqual(12.0, result["windows"][0]["used_percent"])
        self.assertEqual([("anthropic", {})], core.calls)

    def test_core_windows_win(self) -> None:
        """A provider core does fetch is never read a second time by the plugin."""
        core = FakeSnapshot(
            provider="ollama-cloud",
            windows=(
                FakeWindow(
                    label="Session",
                    used_percent=42.0,
                    reset_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
                ),
            ),
        )
        module = self._core_module(core)
        with self._patched_core(module):
            with mock.patch.object(usage_ollama, "fetch_windows") as plugin_fetch:
                result = usage.fetch("ollama-cloud")
        assert result is not None
        self.assertEqual("Session", result["windows"][0]["label"])
        self.assertEqual(42.0, result["windows"][0]["used_percent"])
        self.assertEqual([("ollama-cloud", {"read_only": True})], module.calls)
        plugin_fetch.assert_not_called()

    def test_a_core_without_read_only_is_read_plainly(self) -> None:
        """An older Hermes takes no ``read_only``; it must still answer, not fail the read."""
        core = FakeSnapshot(
            provider="anthropic",
            windows=(
                FakeWindow(
                    label="Session",
                    used_percent=12.0,
                    reset_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
                ),
            ),
        )
        module = self._core_module(core, takes_read_only=False)
        with self._patched_core(module):
            result = usage.fetch("anthropic")
        assert result is not None
        self.assertEqual(12.0, result["windows"][0]["used_percent"])
        self.assertEqual([("anthropic", {})], module.calls)

    def test_a_core_without_read_only_still_falls_back_to_the_balance_read(self) -> None:
        """Ollama Cloud on an older Hermes: core has no fetcher for it, so its plain answer
        (None) must reach the plugin's balance read rather than fail open as no windows."""
        snapshot = usage_ollama.Snapshot(
            provider="ollama-cloud",
            windows=(
                usage_ollama.Window(
                    label="Weekly",
                    used_percent=56.8,
                    reset_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
                ),
            ),
        )
        module = self._core_module(None, takes_read_only=False)
        with self._patched_core(module):
            with mock.patch.object(usage_ollama, "fetch_windows", return_value=snapshot) as plugin_fetch:
                result = usage.fetch("ollama-cloud")
        plugin_fetch.assert_called_once_with()
        assert result is not None
        self.assertEqual("Weekly", result["windows"][0]["label"])
        self.assertEqual([("ollama-cloud", {})], module.calls)

    def test_a_core_without_core_s_own_probe_is_read_by_this_one(self) -> None:
        """A core from before ``interrupt_compat``: the plugin's own probe decides, and a core
        that names the kwarg still gets it."""
        core = FakeSnapshot(
            provider="anthropic",
            windows=(
                FakeWindow(
                    label="Session",
                    used_percent=12.0,
                    reset_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
                ),
            ),
        )
        module = self._core_module(core)
        with self._patched_core(module, has_interrupt_compat=False):
            result = usage.fetch("anthropic")
        assert result is not None
        self.assertEqual([("anthropic", {"read_only": True})], module.calls)

    def test_a_core_that_swallows_kwargs_is_read_with_read_only(self) -> None:
        """Core's probe reads a ``**kwargs`` fetcher as taking the kwarg, so a core that
        forwards it still gets the read that never refreshes a credential."""
        calls: list = []

        def read_swallowing_kwargs(provider, **kwargs):
            calls.append((provider, kwargs))
            return None

        module = mock.MagicMock()
        module.fetch_account_usage = read_swallowing_kwargs
        with self._patched_core(module):
            self.assertIsNone(usage.fetch("anthropic"))
        self.assertEqual([("anthropic", {"read_only": True})], calls)

    def test_falls_back_to_the_plugin_fetcher(self) -> None:
        """Core has no ollama-cloud fetcher, so the balance read answers instead."""
        snapshot = usage_ollama.Snapshot(
            provider="ollama-cloud",
            windows=(
                usage_ollama.Window(
                    label="Included credits",
                    used_percent=71.5,
                    detail="Purchased credits: $25.00",
                ),
            ),
        )
        with self._patched_core(self._core_module(None)):
            with mock.patch.object(usage_ollama, "fetch_windows", return_value=snapshot) as plugin_fetch:
                result = usage.fetch("ollama-cloud")
        plugin_fetch.assert_called_once_with()
        assert result is not None
        self.assertEqual("ollama-cloud", result["provider"])
        self.assertEqual("Included credits", result["windows"][0]["label"])
        self.assertEqual("Purchased credits: $25.00", result["windows"][0]["detail"])

    def test_another_provider_is_not_read_from_ollama(self) -> None:
        with self._patched_core(self._core_module(None)):
            with mock.patch.object(usage_ollama, "fetch_windows") as plugin_fetch:
                self.assertIsNone(usage.fetch("mistral"))
        plugin_fetch.assert_not_called()

    def test_core_exception_is_no_data(self) -> None:
        for provider in ("openrouter", "ollama-cloud"):
            with self.subTest(provider=provider):
                with self._patched_core(self._core_module(error=RuntimeError("core blew up"))):
                    self.assertIsNone(usage.fetch(provider))

    def test_plugin_fetch_exception_is_no_data(self) -> None:
        with self._patched_core(self._core_module(None)):
            with mock.patch.object(
                usage_ollama, "fetch_windows", side_effect=RuntimeError("no balance")
            ):
                self.assertIsNone(usage.fetch("ollama-cloud"))


class _BalanceResponse:
    """The bit of a urllib response the module reads: a context manager with read()."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_BalanceResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def _fake_credential_pool(value: str) -> dict:
    """A stand-in agent.credential_pool whose lookup answers `value` for any key."""
    agent = ModuleType("agent")
    pool = ModuleType("agent.credential_pool")
    pool.get_env_prefer_dotenv = lambda key: value  # type: ignore[attr-defined]
    agent.credential_pool = pool  # type: ignore[attr-defined]
    return {"agent": agent, "agent.credential_pool": pool}


def _urlopen(payload: object, calls: Optional[dict] = None, error: Optional[Exception] = None):
    """A stand-in urlopen: records the request, then answers `payload` or raises `error`."""

    def open_request(request, timeout=None):
        if calls is not None:
            calls.update(
                authorization=request.get_header("Authorization"),
                url=request.full_url,
                timeout=timeout,
            )
        if error is not None:
            raise error
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        return _BalanceResponse(body)

    return open_request


class TestOllamaWindows(unittest.TestCase):
    """The windows Ollama Cloud's /api/balance reports, in either shape or both."""

    legacy = {
        "included": {
            "session": {"remaining_percent": 82.0, "resets_at": "2026-10-15T01:00:00Z"},
            "weekly": {"remaining_percent": 50.0, "resets_at": "2026-10-19T00:00:00+00:00"},
        }
    }
    current = {
        "plan": "Pro",
        "included": {
            "balance_usd": 28.5,
            "allowance_usd": 100.0,
            "period": {"until": "2026-11-01T00:00:00Z"},
        },
        "purchased": {"balance_usd": 25.0},
    }
    # An account that reports the monthly allowance and the legacy pair at once.
    combined = {
        "included": {
            "balance_usd": 28.5,
            "allowance_usd": 100.0,
            "period": {"until": "2026-11-01T00:00:00Z"},
            "session": {"remaining_percent": 82.0, "resets_at": "2026-10-15T01:00:00Z"},
            "weekly": {"remaining_percent": 50.0, "resets_at": "2026-10-19T00:00:00Z"},
        },
        "purchased": {"balance_usd": 25.0},
    }

    def test_legacy_session_and_weekly_map_remaining_to_used(self) -> None:
        windows = usage_ollama.windows_from_payload(self.legacy)
        self.assertEqual(["Session", "Weekly"], [w.label for w in windows])
        self.assertEqual(18.0, windows[0].used_percent)
        self.assertEqual(50.0, windows[1].used_percent)
        self.assertEqual(datetime(2026, 10, 15, 1, 0, tzinfo=timezone.utc), windows[0].reset_at)

    def test_the_monthly_allowance_and_bought_credits_show_in_that_order(self) -> None:
        windows = usage_ollama.windows_from_payload(self.current)
        self.assertEqual(["Monthly", "Credits"], [w.label for w in windows])
        self.assertAlmostEqual(71.5, windows[0].used_percent)
        self.assertEqual(datetime(2026, 11, 1, tzinfo=timezone.utc), windows[0].reset_at)
        self.assertIsNone(windows[0].detail)
        self.assertEqual(0.0, windows[1].used_percent)
        self.assertEqual("$25.00", windows[1].detail)

    def test_no_credits_window_without_a_balance(self) -> None:
        windows = usage_ollama.windows_from_payload(
            {
                "included": {
                    "allowance_usd": 100.0,
                    "balance_usd": 28.5,
                    "period": {"until": "2026-11-01T00:00:00Z"},
                },
                "purchased": {"balance_usd": 0},
            }
        )
        self.assertEqual(["Monthly"], [w.label for w in windows])

    def test_a_weekly_block_sits_above_the_monthly_allowance(self) -> None:
        windows = usage_ollama.windows_from_payload(
            {
                "included": {
                    "allowance_usd": 100.0,
                    "balance_usd": 28.5,
                    "period": {"until": "2026-11-01T00:00:00Z"},
                    "weekly": {"remaining_percent": 50.0, "resets_at": "2026-10-19T00:00:00Z"},
                }
            }
        )
        self.assertEqual(["Weekly", "Monthly"], [w.label for w in windows])
        self.assertEqual(50.0, windows[0].used_percent)
        self.assertAlmostEqual(71.5, windows[1].used_percent)

    def test_every_window_an_account_reports_appears_in_order(self) -> None:
        windows = usage_ollama.windows_from_payload(self.combined)
        self.assertEqual(["Session", "Weekly", "Monthly", "Credits"], [w.label for w in windows])
        self.assertEqual(18.0, windows[0].used_percent)
        self.assertEqual(50.0, windows[1].used_percent)
        self.assertAlmostEqual(71.5, windows[2].used_percent)
        self.assertEqual("$25.00", windows[3].detail)

    def test_naive_reset_stamp_reads_as_utc(self) -> None:
        windows = usage_ollama.windows_from_payload(
            {"included": {"session": {"remaining_percent": 10, "resets_at": "2026-10-15T01:00:00"}}}
        )
        self.assertEqual(timezone.utc, windows[0].reset_at.tzinfo)

    def test_unknown_shapes_yield_no_windows(self) -> None:
        for payload in (
            {},
            [],
            {"included": "nope"},
            {"included": {"allowance_usd": 0, "balance_usd": 0}},
            {"included": {"session": {"remaining_percent": "lots"}}},
        ):
            self.assertEqual((), usage_ollama.windows_from_payload(payload), payload)

    def test_serialize_renders_the_windows(self) -> None:
        snapshot = usage_ollama.Snapshot(
            provider="ollama-cloud",
            windows=usage_ollama.windows_from_payload(self.current),
            plan="Pro",
        )
        result = usage.serialize(snapshot, now=datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc))
        assert result is not None
        self.assertEqual("ollama-cloud", result["provider"])
        self.assertEqual("Pro", result["plan"])
        self.assertEqual(["Monthly", "Credits"], [w["label"] for w in result["windows"]])
        self.assertEqual("2026-11-01T00:00:00+00:00", result["windows"][0]["resets_at"])
        self.assertIsNone(result["windows"][0]["detail"])
        self.assertEqual("$25.00", result["windows"][1]["detail"])


class TestOllamaFetch(unittest.TestCase):
    """fetch_windows(): the key it uses, and every way it fails open."""

    legacy = TestOllamaWindows.legacy

    def test_reads_the_balance_with_the_profile_key(self) -> None:
        calls: dict = {}
        with mock.patch.dict("sys.modules", _fake_credential_pool("sk-ollama")):
            with mock.patch.object(
                usage_ollama.urllib.request, "urlopen", _urlopen(self.legacy, calls)
            ):
                snapshot = usage_ollama.fetch_windows()
        assert snapshot is not None
        self.assertEqual("ollama-cloud", snapshot.provider)
        self.assertEqual(["Session", "Weekly"], [w.label for w in snapshot.windows])
        self.assertEqual("Bearer sk-ollama", calls["authorization"])
        self.assertEqual(usage_ollama.BALANCE_URL, calls["url"])
        self.assertEqual(usage_ollama.TIMEOUT_S, calls["timeout"])

    def test_missing_key_returns_none(self) -> None:
        with mock.patch.dict("sys.modules", _fake_credential_pool("")):
            with mock.patch.object(usage_ollama.urllib.request, "urlopen", _urlopen(self.legacy)):
                self.assertIsNone(usage_ollama.fetch_windows())

    def test_never_reads_os_environ(self) -> None:
        """A key in the process env must not leak: that one belongs to the launch profile."""
        with mock.patch.dict("sys.modules", _fake_credential_pool("")):
            with mock.patch.dict("os.environ", {"OLLAMA_API_KEY": "sk-launch-profile"}):
                with mock.patch.object(usage_ollama.urllib.request, "urlopen", _urlopen(self.legacy)):
                    self.assertIsNone(usage_ollama.fetch_windows())

    def test_refusals_return_none(self) -> None:
        for status in (401, 429):
            with self.subTest(status=status):
                error = urllib.error.HTTPError(usage_ollama.BALANCE_URL, status, "no", {}, None)
                with mock.patch.dict("sys.modules", _fake_credential_pool("sk-ollama")):
                    with mock.patch.object(
                        usage_ollama.urllib.request, "urlopen", _urlopen(None, error=error)
                    ):
                        self.assertIsNone(usage_ollama.fetch_windows())

    def test_unreadable_bodies_return_none(self) -> None:
        for payload in (b"not json", b'{"included": "nope"}', b"{}"):
            with self.subTest(payload=payload):
                with mock.patch.dict("sys.modules", _fake_credential_pool("sk-ollama")):
                    with mock.patch.object(
                        usage_ollama.urllib.request, "urlopen", _urlopen(payload)
                    ):
                        self.assertIsNone(usage_ollama.fetch_windows())

    def test_hermes_import_stays_deferred(self) -> None:
        """The module imports with no Hermes: nothing at module level names an agent package."""
        source = inspect.getsource(usage_ollama)
        module_level = [line for line in source.splitlines() if line.startswith(("import ", "from "))]
        self.assertEqual([], [line for line in module_level if "agent" in line])
        self.assertIn("from agent.credential_pool import", inspect.getsource(usage_ollama.api_key))


if __name__ == "__main__":
    unittest.main()