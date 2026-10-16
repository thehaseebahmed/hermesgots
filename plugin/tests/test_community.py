"""The community leaderboard's counters and report.

Run: python3 -m unittest plugin.tests.test_community -v
"""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import community, sessions
from plugin.store import db_path


class CommunityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: str(self.home)
        patcher = mock.patch.dict(sys.modules, {"hermes_constants": constants})
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def call(self, **overrides) -> None:
        usage = {"input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 5, "cache_write_tokens": 1}
        community.record(
            **{
                "platform": "api_server",
                "model": "Anthropic/Claude-Opus-5-5",
                "session_id": "memento-1",
                "usage": usage,
                **overrides,
            }
        )

    def test_counts_per_day_model_and_mode_and_keeps_no_text(self) -> None:
        with mock.patch.object(sessions, "record_for", return_value={"mode": "plan"}):
            self.call()
            self.call()
        with mock.patch.object(sessions, "record_for", return_value=None):
            self.call()
        days = community.payload(self.home)["days"]
        (day,) = days.values()
        modes = day["anthropic/claude-opus-5-5"]
        self.assertEqual(modes["plan"], {"input": 200, "output": 40, "cacheWrite": 2, "cacheRead": 10, "calls": 2})
        self.assertEqual(modes["chat"]["calls"], 1)
        import sqlite3

        conn = sqlite3.connect(db_path(self.home))
        columns = {row[1] for row in conn.execute("PRAGMA table_info(community_usage)")}
        conn.close()
        self.assertNotIn("session_id", columns)

    def test_a_session_with_an_active_goal_counts_as_goal(self) -> None:
        from plugin import goal

        community._goal_seen.clear()
        self.addCleanup(community._goal_seen.clear)
        active = types.SimpleNamespace(state=types.SimpleNamespace(status="active"))
        done = types.SimpleNamespace(state=types.SimpleNamespace(status="done"))
        with mock.patch.object(sessions, "record_for", return_value={"mode": "plan"}):
            with mock.patch.object(goal, "manager", return_value=active):
                self.call(session_id="memento-goal")
            with mock.patch.object(goal, "manager", return_value=done):
                self.call(session_id="memento-done")
            with mock.patch.object(goal, "manager", side_effect=goal.GoalError("no /goal", 501)):
                self.call(session_id="memento-old")
        modes = next(iter(community.payload(self.home)["days"].values()))["anthropic/claude-opus-5-5"]
        self.assertEqual(modes["goal"]["calls"], 1)
        self.assertEqual(modes["plan"]["calls"], 2)

    def test_tokens_are_counted_per_provider_without_a_custom_endpoint_name(self) -> None:
        self.call(provider="anthropic")
        self.call(provider="Custom:Acme Corp", model="llama-4")
        self.call()
        (day,) = community.payload(self.home)["providers"].values()
        self.assertEqual(day["anthropic"], {"anthropic/claude-opus-5-5": 126})
        self.assertEqual(day["custom"], {"llama-4": 126})
        self.assertEqual(day["unknown"], {"anthropic/claude-opus-5-5": 126})

    def test_other_surfaces_and_empty_usage_are_ignored(self) -> None:
        self.call(platform="telegram")
        self.call(usage={"input_tokens": 0})
        self.call(usage=None)
        self.call(model="")
        self.assertEqual(community.payload(self.home), {"days": {}, "providers": {}})

    def test_sync_reports_only_when_joined_and_changed(self) -> None:
        self.call()
        calls = []

        def fake(site, method, route, **kwargs):
            calls.append((method, route, kwargs["function"]))
            return {"enabled": joined} if route == "community" else {"ok": True}

        state = {"token": "mh_x", "site": "https://gots.test"}
        joined = False
        community.sync(self.home, state, fake)
        self.assertEqual(calls, [("GET", "community", "community")])
        self.assertNotIn("community", state)

        joined = True
        calls.clear()
        community.sync(self.home, state, fake)
        self.assertEqual([c[1] for c in calls], ["community", "report"])
        calls.clear()
        community.sync(self.home, state, fake)
        self.assertEqual([c[1] for c in calls], ["community"])
        self.call()
        calls.clear()
        community.sync(self.home, state, fake)
        self.assertEqual([c[1] for c in calls], ["community", "report"])

    def test_a_failed_report_is_tried_again(self) -> None:
        self.call()
        state = {"token": "mh_x", "site": "https://gots.test"}

        def failing(site, method, route, **kwargs):
            if route == "report":
                raise RuntimeError("down")
            return {"enabled": True}

        community.sync(self.home, state, failing)
        self.assertNotIn("community", state)


if __name__ == "__main__":
    unittest.main()
