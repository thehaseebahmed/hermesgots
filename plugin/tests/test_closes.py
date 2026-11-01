"""Tests for a session's close: recorded before any of it runs, run off the request, read back as a
report that outlives the session row (closes.py, ADR 0075)."""

import unittest
from unittest.mock import patch

from plugin import afk, closes, events, sessions, ship, store
from plugin.tests._helpers import temp_hermes_home

RECORD = {
    "session_id": "s-1",
    "project_id": "p-1",
    "repos": [
        {
            "name": "acme/app",
            "repo_root": "/repos/app",
            "path": "/repos/app/wt",
            "branch": "memento/s-1",
        }
    ],
}


class CloseTests(unittest.TestCase):
    def setUp(self):
        self.home = temp_hermes_home(self)
        self.path = store.db_path(self.home)

    def start(self, record=RECORD, spawned=None):
        """Asks for a close with the work's start recorded instead of run."""
        asked = spawned if spawned is not None else []
        with (
            patch.object(sessions, "record_for", return_value=record),
            patch.object(closes, "spawn", side_effect=lambda *a: asked.append(a)),
        ):
            return closes.start(self.path, self.home, "s-1")

    def test_a_close_is_recorded_before_it_runs(self):
        asked = []
        with (
            patch.object(sessions, "record_for", return_value=RECORD),
            patch.object(closes, "spawn", side_effect=lambda *a: asked.append(a)),
            patch.object(afk, "release_session") as release,
            patch.object(ship, "close") as closed,
        ):
            row = closes.start(self.path, self.home, "s-1")
        self.assertEqual(row["state"], "closing")
        # The snapshot the report is read from, taken while the session row is still there.
        self.assertEqual(row["repos"], RECORD["repos"])
        self.assertEqual(len(asked), 1)
        self.assertFalse(release.called)
        self.assertFalse(closed.called)

    def test_a_finished_close_is_its_report(self):
        self.start(spawned=[])
        with (
            patch.object(afk, "release_session", return_value=True),
            patch.object(afk, "wake"),
            patch.object(
                sessions,
                "remove",
                return_value={"removed": False, "kept": [{"name": "acme/app", "reason": "dirty"}]},
            ),
            patch.object(
                ship,
                "close",
                return_value=[
                    {"name": "acme/app", "closed": 12, "branch_deleted": True, "error": None}
                ],
            ),
            patch.object(events, "note") as noted,
        ):
            closes.run(self.path, self.home, "s-1", RECORD)
        row = closes.read(self.path, "s-1")
        self.assertEqual(row["state"], "done")
        self.assertFalse(row["removed"])
        self.assertEqual(row["kept"], [{"name": "acme/app", "reason": "dirty"}])
        self.assertEqual(row["results"][0]["closed"], 12)
        self.assertIsNotNone(row["ended_at"])
        # The app is told to read it now, rather than finding it on its next pass.
        self.assertEqual(noted.call_args[0][0], "closes")

    def test_a_removal_that_failed_is_reported(self):
        self.start(spawned=[])
        with (
            patch.object(afk, "release_session", return_value=False),
            patch.object(
                sessions, "remove", side_effect=sessions.WorkspaceError("git refused to remove")
            ),
            patch.object(ship, "close", return_value=[]),
        ):
            closes.run(self.path, self.home, "s-1", RECORD)
        row = closes.read(self.path, "s-1")
        self.assertEqual(row["state"], "done")
        self.assertEqual(row["error"], "git refused to remove")

    def test_a_close_a_restart_left_runs_again(self):
        closes._resumed.clear()
        self.start(spawned=[])  # left closing
        with patch.object(closes, "spawn") as spawn:
            closes.resume(self.home)
        self.assertEqual(spawn.call_args[0][2], "s-1")

    def test_a_close_that_ended_is_not_run_again(self):
        self.start(record=None, spawned=[])  # ends at once: nothing on the host to close
        closes._resumed.clear()
        with patch.object(closes, "spawn") as spawn:
            closes.resume(self.home)
        self.assertFalse(spawn.called)

    def test_a_second_ask_answers_the_close_already_running(self):
        first = self.start(spawned=[])
        closes._running.add((str(self.path), "s-1"))
        asked = []
        try:
            second = self.start(spawned=asked)
        finally:
            closes._running.discard((str(self.path), "s-1"))
        self.assertEqual(second["started_at"], first["started_at"])
        self.assertEqual(asked, [])

    def test_a_close_left_unrun_is_started_by_the_next_ask(self):
        self.start(spawned=[])  # recorded, and nothing running it
        asked = []
        self.start(spawned=asked)
        self.assertEqual(len(asked), 1)

    def test_a_session_the_host_never_had_ends_at_once(self):
        asked = []
        row = self.start(record=None, spawned=asked)
        self.assertEqual(row["state"], "done")
        self.assertTrue(row["removed"])
        self.assertEqual(row["kept"], [])
        self.assertEqual(asked, [])


class CloseReadTests(unittest.TestCase):
    def setUp(self):
        self.home = temp_hermes_home(self)
        self.path = store.db_path(self.home)

    def test_a_session_never_asked_about_has_no_close(self):
        self.assertIsNone(closes.read(self.path, "unknown"))

    def test_recent_holds_every_close_the_host_keeps(self):
        with patch.object(sessions, "record_for", return_value=None):
            closes.start(self.path, self.home, "a")
            closes.start(self.path, self.home, "b")
        found = {row["session_id"] for row in closes.recent(self.path)}
        self.assertEqual(found, {"a", "b"})
