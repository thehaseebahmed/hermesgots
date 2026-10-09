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

from plugin import alerts, chats, push
from plugin.store import connect, db_path


class Categories(unittest.TestCase):
    def test_an_older_subscription_wants_what_it_always_got(self):
        row = {"categories": None}
        for category in ("chat_input", "code_input"):
            self.assertTrue(push.wants(row, category))
        for category in ("code_theseus", "chat_run_done", "code_run_failed", "routine_failed"):
            self.assertFalse(push.wants(row, category))

    def test_a_subscription_wants_only_what_it_listed(self):
        row = {"categories": '["code_run_failed"]'}
        self.assertTrue(push.wants(row, "code_run_failed"))
        self.assertFalse(push.wants(row, "chat_run_failed"))
        self.assertFalse(push.wants(row, "chat_input"))

    def test_unknown_categories_are_dropped(self):
        self.assertEqual(
            push.clean_categories(["code_input", "nonsense", "chat_run_done"]),
            ["chat_run_done", "code_input"],
        )
        self.assertIsNone(push.clean_categories(None))
        self.assertEqual(push.clean_categories([]), [])

    def test_a_kind_belongs_to_the_feature_of_its_session(self):
        self.assertEqual(push.category_of("question"), "chat_input")
        self.assertEqual(push.category_of("question", project=True), "code_input")
        self.assertEqual(push.category_of("plan"), "code_input")
        self.assertEqual(push.category_of("run_failed"), "chat_run_failed")
        self.assertEqual(push.category_of("run_done", project=True), "code_run_done")
        self.assertEqual(push.category_of("theseus"), "code_theseus")
        self.assertEqual(push.category_of("pr_checks"), "code_pr_checks")
        self.assertEqual(push.category_of("clone_failed"), "code_setup_failed")
        self.assertEqual(push.category_of("routine_failed"), "routine_failed")

    def test_every_kind_lands_in_a_category_that_exists(self):
        for kind in push.KINDS:
            for project in (False, True):
                self.assertIn(push.category_of(kind, project), push.CATEGORIES)

    def test_a_database_from_before_categories_gains_the_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "memento.db"
            old = sqlite3.connect(path)
            old.execute(
                """CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, device TEXT NOT NULL,
                   p256dh TEXT NOT NULL, auth TEXT NOT NULL, vapid_key TEXT NOT NULL,
                   subject TEXT NOT NULL, created_at INTEGER NOT NULL)"""
            )
            old.execute("PRAGMA user_version = 13")
            old.commit()
            old.close()
            conn = connect(path)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(push_subscriptions)")}
            conn.close()
            self.assertIn("categories", columns)

    def test_once_tells_a_thing_a_single_time_until_cleared(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "memento.db"
            self.assertTrue(push.once(path, "a"))
            self.assertFalse(push.once(path, "a"))
            self.assertTrue(push.once(path, "b"))
            push.clear(path, "a")
            self.assertTrue(push.once(path, "a"))


class Mutes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = db_path(Path(self.tmp.name))
        self.parents = {}
        patch = mock.patch("plugin.sessions._parent_of", lambda home, sid: self.parents.get(sid))
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)

    def chat(self, chat_id, session, muted=None):
        value = {"hermesSessionId": session, "title": "t", "createdAt": 1, "updatedAt": 1}
        if muted is not None:
            value["muted"] = muted
        chats.merge(self.path, {chat_id: {"at": 1, "value": value}})

    def test_nothing_is_muted_by_default(self):
        self.chat("a", "memento-a")
        self.assertFalse(push.muted(self.path, "question", "memento-a"))

    def test_a_muted_bot_mutes_everything_it_would_say(self):
        push.set_bot_muted(self.path, True)
        for kind in ("question", "run_failed", "routine_failed", "clone_failed"):
            self.assertTrue(push.muted(self.path, kind, "x"))
        push.set_bot_muted(self.path, False)
        self.assertFalse(push.muted(self.path, "routine_failed", "x"))

    def test_a_muted_thread_mutes_its_own_session_only(self):
        self.chat("a", "memento-a", muted=True)
        self.chat("b", "memento-b")
        self.assertTrue(push.muted(self.path, "approval", "memento-a"))
        self.assertTrue(push.muted(self.path, "run_done", "memento-a"))
        self.assertFalse(push.muted(self.path, "approval", "memento-b"))
        # Not about a session: a thread's mute has no say.
        self.assertFalse(push.muted(self.path, "routine_failed", "memento-a"))

    def test_a_compressed_session_is_still_its_chats(self):
        self.chat("a", "memento-a", muted=True)
        self.parents["child"] = "memento-a"
        self.assertTrue(push.muted(self.path, "question", "child"))

    def test_unmuting_a_thread_clears_it(self):
        self.chat("a", "memento-a", muted=True)
        chats.merge(
            self.path,
            {"a": {"at": 2, "value": {"hermesSessionId": "memento-a", "title": "t", "createdAt": 1, "updatedAt": 1}}},
        )
        self.assertFalse(push.muted(self.path, "question", "memento-a"))


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
