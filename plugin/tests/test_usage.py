"""Serializing account-usage snapshots for the app.

Run: python3 -m unittest plugin.tests.test_usage -v
"""

from __future__ import annotations

import importlib.util
import unittest
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from unittest import mock

# Import usage.py directly, avoiding plugin/__init__.py's import chain
# (which pulls in cryptography and other Hermes-host deps).
_spec = importlib.util.spec_from_file_location(
    "plugin_usage", Path(__file__).resolve().parent.parent / "usage.py"
)
usage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(usage)


@dataclass(frozen=True)
class FakeWindow:
    label: str
    used_percent: Optional[float] = None
    reset_at: Optional[datetime] = None
    detail: Optional[str] = None
    scope: str = "account"


@dataclass(frozen=True)
class FakeSnapshot:
    provider: str
    source: str = "test"
    fetched_at: datetime = None  # type: ignore
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


if __name__ == "__main__":
    unittest.main()