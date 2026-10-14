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
        with mock.patch.dict("sys.modules", {"agent": mock.MagicMock(), "agent.account_usage": fake_mod}):
            result = usage.fetch("some-unknown-provider")
            self.assertIsNone(result)


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
    """The two payload shapes Ollama Cloud answers /api/balance with."""

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

    def test_legacy_session_and_weekly_map_remaining_to_used(self) -> None:
        windows = usage_ollama.windows_from_payload(self.legacy)
        self.assertEqual(["Session", "Weekly"], [w.label for w in windows])
        self.assertEqual(18.0, windows[0].used_percent)
        self.assertEqual(50.0, windows[1].used_percent)
        self.assertEqual(datetime(2026, 10, 15, 1, 0, tzinfo=timezone.utc), windows[0].reset_at)

    def test_current_allowance_reports_used_and_purchased_detail(self) -> None:
        windows = usage_ollama.windows_from_payload(self.current)
        self.assertEqual(1, len(windows))
        self.assertEqual("Included credits", windows[0].label)
        self.assertAlmostEqual(71.5, windows[0].used_percent)
        self.assertEqual(datetime(2026, 11, 1, tzinfo=timezone.utc), windows[0].reset_at)
        self.assertEqual("Purchased credits: $25.00", windows[0].detail)

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
        self.assertEqual("Included credits", result["windows"][0]["label"])
        self.assertEqual("2026-11-01T00:00:00+00:00", result["windows"][0]["resets_at"])
        self.assertEqual("Purchased credits: $25.00", result["windows"][0]["detail"])


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