"""Which pushes a device asked for, and the news that produces them.

Run: python3 -m unittest plugin.tests.test_push_kinds -v
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

from plugin import alerts, push
from plugin.store import connect, db_path


class Kinds(unittest.TestCase):
    def test_an_older_subscription_wants_what_it_always_got(self):
        row = {"kinds": None}
        for kind in ("approval", "question", "plan"):
            self.assertTrue(push.wants(row, kind))
        for kind in ("theseus", "run_done", "run_failed", "pr_checks", "routine_failed"):
            self.assertFalse(push.wants(row, kind))

    def test_a_subscription_wants_only_what_it_listed(self):
        row = {"kinds": '["run_failed"]'}
        self.assertTrue(push.wants(row, "run_failed"))
        self.assertFalse(push.wants(row, "approval"))

    def test_unknown_kinds_are_dropped(self):
        self.assertEqual(push.clean_kinds(["plan", "nonsense", "run_done"]), ["plan", "run_done"])
        self.assertIsNone(push.clean_kinds(None))
        self.assertEqual(push.clean_kinds([]), [])

    def test_a_database_from_before_kinds_gains_the_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "memento.db"
            old = sqlite3.connect(path)
            old.execute(
                """CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, device TEXT NOT NULL,
                   p256dh TEXT NOT NULL, auth TEXT NOT NULL, vapid_key TEXT NOT NULL,
                   subject TEXT NOT NULL, created_at INTEGER NOT NULL)"""
            )
            old.execute("PRAGMA user_version = 11")
            old.commit()
            old.close()
            conn = connect(path)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(push_subscriptions)")}
            conn.close()
            self.assertIn("kinds", columns)

    def test_once_tells_a_thing_a_single_time_until_cleared(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "memento.db"
            self.assertTrue(push.once(path, "a"))
            self.assertFalse(push.once(path, "a"))
            self.assertTrue(push.once(path, "b"))
            push.clear(path, "a")
            self.assertTrue(push.once(path, "a"))


class Turns(unittest.TestCase):
    def setUp(self):
        alerts._started.clear()
        self.told = []
        self.patches = [
            mock.patch.object(push, "notify", lambda kind, sid, path=None: self.told.append((kind, sid))),
            mock.patch.object(alerts.sessions, "_paths", lambda: (Path("/nonexistent/m.db"), Path("/x"))),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()

    def end(self, session="memento-1", **flags):
        alerts.turn_finished(session_id=session, platform="api_server", **flags)

    def test_a_failed_turn_is_told_at_once(self):
        alerts.turn_started(session_id="memento-1", platform="api_server")
        self.end(completed=False, failed=True, interrupted=False)
        self.assertEqual(self.told, [("run_failed", "memento-1")])

    def test_a_stopped_turn_is_not_a_failure(self):
        alerts.turn_started(session_id="memento-1", platform="api_server")
        self.end(completed=False, failed=True, interrupted=True)
        self.assertEqual(self.told, [])

    def test_a_short_turn_that_finished_is_not_news(self):
        alerts.turn_started(session_id="memento-1", platform="api_server")
        self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [])

    def test_a_long_turn_that_finished_is(self):
        alerts._started["memento-1"] = time.monotonic() - alerts.RUN_DONE_MIN_S - 1
        self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [("run_done", "memento-1")])

    def test_a_session_of_another_surface_is_ignored(self):
        alerts._started["telegram-9"] = time.monotonic() - 1000
        self.end(session="telegram-9", completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [])


class Theseus(unittest.TestCase):
    def test_a_looping_wait_pushes_once_per_stage(self):
        alerts._waits.clear()
        told = []
        stages = iter(["plan", "plan", "plan", "approval"])
        theseus = types.ModuleType("plugin.theseus")
        theseus.waiting_stage = lambda record: next(stages)
        record = {"session_id": "s1"}
        wait = {"command": "node theseus wait --timeout 120"}
        with mock.patch.object(push, "notify", lambda kind, sid, path=None: told.append((kind, sid))):
            with mock.patch.dict(sys.modules, {"plugin.theseus": theseus}):
                with mock.patch("plugin.theseus", theseus, create=True):
                    for _ in range(3):
                        alerts.theseus_tool(Path("p"), record, "terminal", wait)
                    # The agent did something else: the next wait is a new round.
                    alerts.theseus_tool(Path("p"), record, "write_file", {})
                    alerts.theseus_tool(Path("p"), record, "terminal", wait)
        self.assertEqual(told, [("theseus", "s1"), ("theseus", "s1")])


class Routines(unittest.TestCase):
    def run_pass(self, rows, now):
        cron = types.ModuleType("cron")
        executions = types.ModuleType("cron.executions")
        executions.list_executions = lambda job_id=None, limit=3: rows
        jobs = types.ModuleType("cron.jobs")
        jobs.list_jobs = lambda include_disabled=True: [{"id": "job1"}]
        told = []
        with tempfile.TemporaryDirectory() as tmp:
            path = db_path(Path(tmp))
            with mock.patch.dict(
                sys.modules, {"cron": cron, "cron.executions": executions, "cron.jobs": jobs}
            ):
                with mock.patch.object(push, "notify", lambda kind, sid, path=None: told.append((kind, sid))):
                    first = alerts.check_routines(path, now)
                    second = alerts.check_routines(path, now)
        return first, second, told

    def test_a_fresh_failure_is_told_once(self):
        now = time.time()
        finished = (datetime.now().astimezone() - timedelta(minutes=2)).isoformat()
        rows = [{"id": "r1", "status": "failed", "finished_at": finished}]
        first, second, told = self.run_pass(rows, now)
        self.assertEqual((first, second), (1, 0))
        self.assertEqual(told, [("routine_failed", "job1")])

    def test_an_old_failure_and_a_good_run_are_not_news(self):
        now = time.time()
        old = (datetime.now().astimezone() - timedelta(hours=5)).isoformat()
        fresh = (datetime.now().astimezone() - timedelta(minutes=2)).isoformat()
        rows = [
            {"id": "r1", "status": "failed", "finished_at": old},
            {"id": "r2", "status": "completed", "finished_at": fresh},
        ]
        first, _, told = self.run_pass(rows, now)
        self.assertEqual(first, 0)
        self.assertEqual(told, [])

    def test_a_delivery_that_failed_after_a_good_run_counts(self):
        now = time.time()
        fresh = (datetime.now().astimezone() - timedelta(minutes=2)).isoformat()
        rows = [{"id": "r3", "status": "completed", "delivery_outcome": "failed", "finished_at": fresh}]
        first, _, _ = self.run_pass(rows, now)
        self.assertEqual(first, 1)


if __name__ == "__main__":
    unittest.main()
