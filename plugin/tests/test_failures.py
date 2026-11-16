"""What a chat's last failed turn ended with, and who is told about it.

Hermes closes a turn it gave up on with one notice in the transcript for every failure, and keeps
the provider's own words out of it: the words ride the run's ending, which only the device watching
the run sees. The turn's own end keeps them here, so a second device — or this one the next morning
— reads the reason rather than the notice.

Run: python3 -m unittest plugin.tests.test_failures -v
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

from plugin import failures, sessions


class FakeAdapter:
    """Stands in for the API server: its pollable run statuses are all this reads."""

    def __init__(self, *runs: Dict[str, Any]) -> None:
        self._run_statuses = {run["run_id"]: run for run in runs}


def run(status: str = "failed", error: Any = "Provider refused the key.", **extra: Any) -> Dict[str, Any]:
    return {"run_id": extra.pop("run_id", "run_1"), "status": status, "error": error, **extra}


class ReasonOf(unittest.TestCase):
    def test_the_newest_failed_run_of_the_session_says_why(self):
        adapter = FakeAdapter(
            run(run_id="run_1", session_id="s", updated_at=100, error="Old reason."),
            run(run_id="run_2", session_id="s", updated_at=200, error="Usage is spent."),
        )
        self.assertEqual(failures.reason_of(adapter, "s"), ("Usage is spent.", 200))

    def test_a_run_that_finished_says_nothing(self):
        adapter = FakeAdapter(run(status="completed", session_id="s", updated_at=200))
        self.assertIsNone(failures.reason_of(adapter, "s"))

    def test_a_failure_with_no_words_is_left_to_the_notice(self):
        adapter = FakeAdapter(run(session_id="s", updated_at=200, error="agent run failed"))
        self.assertIsNone(failures.reason_of(adapter, "s"))

    def test_a_failure_that_is_not_a_string_is_left_to_the_notice(self):
        adapter = FakeAdapter(run(session_id="s", updated_at=200, error={"code": "bad_key"}))
        self.assertIsNone(failures.reason_of(adapter, "s"))

    def test_another_sessions_run_is_not_mine(self):
        adapter = FakeAdapter(run(session_id="other", updated_at=200))
        self.assertIsNone(failures.reason_of(adapter, "s"))

    def test_an_adapter_without_run_statuses_answers_nothing(self):
        self.assertIsNone(failures.reason_of(object(), "s"))


class Store(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())

    def test_a_failure_reads_back(self):
        path = self.home / "gots.db"
        failures.write(path, "s", "Usage is spent.", 1_800_000_000)
        self.assertEqual(failures.read(path, "s"), {"text": "Usage is spent.", "at": 1_800_000_000})

    def test_the_newest_failure_replaces_the_one_before(self):
        path = self.home / "gots.db"
        failures.write(path, "s", "First.", 100)
        failures.write(path, "s", "Second.", 200)
        self.assertEqual(failures.read(path, "s")["text"], "Second.")

    def test_a_cleared_session_keeps_nothing(self):
        path = self.home / "gots.db"
        failures.write(path, "s", "Usage is spent.", 100)
        failures.clear(path, "s")
        self.assertIsNone(failures.read(path, "s"))

    def test_a_store_that_was_never_written_answers_nothing(self):
        self.assertIsNone(failures.read(self.home / "absent.db", "s"))


class Hook(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "gots.db"
        self.path.touch()
        self.adapter = FakeAdapter(run(session_id="s", updated_at=200, error="Usage is spent."))
        self.patches = [
            mock.patch.object(sessions, "_paths", lambda: (self.path, self.path.parent)),
            mock.patch.object(sessions, "adapter", self.adapter),
            mock.patch.object(sessions, "record_for", lambda *_: {"session_id": "s"}),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()

    def end(self, **flags):
        failures.after_run(session_id="s", platform="api_server", **flags)

    def test_a_failed_turn_keeps_what_its_run_ended_with(self):
        self.end(completed=False, failed=True, interrupted=False)
        self.assertEqual(failures.read(self.path, "s")["text"], "Usage is spent.")

    def test_a_stopped_turn_keeps_nothing(self):
        self.end(completed=False, failed=True, interrupted=True)
        self.assertIsNone(failures.read(self.path, "s"))

    def test_a_turn_that_finished_keeps_nothing(self):
        self.end(completed=True, failed=False, interrupted=False)
        self.assertIsNone(failures.read(self.path, "s"))

    def test_a_session_that_is_not_one_of_the_apps_chats_keeps_nothing(self):
        with mock.patch.object(sessions, "record_for", lambda *_: None):
            self.end(completed=False, failed=True, interrupted=False)
        self.assertIsNone(failures.read(self.path, "s"))

    def test_a_hook_that_cannot_read_the_runs_never_raises(self):
        with mock.patch.object(sessions, "adapter", object()):
            self.end(completed=False, failed=True, interrupted=False)
        self.assertIsNone(failures.read(self.path, "s"))
