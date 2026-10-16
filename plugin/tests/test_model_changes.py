"""The model history a chat's thread draws its dividers from.

Run: python3 -m unittest plugin.tests.test_model_changes -v
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import context, model_changes
from plugin.store import connect, db_path


class ModelChangesTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.path = db_path(self.home)
        fake = types.ModuleType("hermes_constants")
        fake.get_hermes_home = lambda: self.home  # type: ignore[attr-defined]
        self._patch = mock.patch.dict(sys.modules, {"hermes_constants": fake})
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    def call(self, session="s1", model="anthropic/claude-sonnet-4.5", provider="openrouter", **kw):
        model_changes.record(
            platform="api_server", session_id=session, model=model, provider=provider, **kw
        )

    def rows(self, session="s1"):
        if not self.path.exists():
            return []
        conn = sqlite3.connect(self.path)
        try:
            return conn.execute(
                "SELECT model FROM model_changes WHERE session_id = ? ORDER BY at", (session,)
            ).fetchall()
        finally:
            conn.close()

    def test_first_call_is_recorded(self) -> None:
        self.call()
        self.assertEqual(self.rows(), [("anthropic/claude-sonnet-4.5",)])

    def test_same_model_appends_nothing(self) -> None:
        self.call()
        self.call()
        self.assertEqual(len(self.rows()), 1)

    def test_vendor_prefix_and_dots_are_the_same_model(self) -> None:
        self.call(model="anthropic/claude-sonnet-4.5")
        self.call(model="claude-sonnet-4-5")
        self.assertEqual(len(self.rows()), 1)

    def test_real_change_appends_a_row(self) -> None:
        self.call(model="anthropic/claude-sonnet-4.5")
        self.call(model="openai/gpt-5")
        self.assertEqual(len(self.rows()), 2)

    def test_other_platforms_and_missing_model_append_nothing(self) -> None:
        model_changes.record(platform="telegram", session_id="s1", model="openai/gpt-5")
        model_changes.record(platform="api_server", session_id="s1", model="")
        model_changes.record(platform="api_server", session_id="", model="openai/gpt-5")
        self.assertEqual(self.rows(), [])

    def test_read_is_oldest_first_across_asked_and_resolved_ids(self) -> None:
        self.call(session="parent", model="anthropic/claude-sonnet-4.5")
        self.call(session="child", model="openai/gpt-5")
        found = model_changes.read(self.path, "child", also="parent")
        self.assertEqual([row["model"] for row in found], ["anthropic/claude-sonnet-4.5", "openai/gpt-5"])
        self.assertEqual(set(found[0]), {"at", "model", "provider"})

    def test_read_collapses_consecutive_same_models(self) -> None:
        conn = connect(self.path)
        conn.execute(
            "INSERT INTO model_changes (session_id, at, model, provider) VALUES "
            "('s1', 1, 'anthropic/claude-sonnet-4.5', 'a'), ('s1', 2, 'claude-sonnet-4-5', 'a'), "
            "('s1', 3, 'openai/gpt-5', 'o')"
        )
        conn.close()
        found = model_changes.read(self.path, "s1")
        self.assertEqual([row["model"] for row in found], ["anthropic/claude-sonnet-4.5", "openai/gpt-5"])

    def test_old_rows_are_pruned(self) -> None:
        conn = connect(self.path)
        old = 1
        conn.execute(
            "INSERT INTO model_changes (session_id, at, model, provider) VALUES ('s1', ?, 'old', NULL)",
            (old,),
        )
        conn.close()
        self.call(model="openai/gpt-5")
        self.assertEqual(self.rows(), [("openai/gpt-5",)])
        self.assertGreater(context.KEEP_MS, 0)

    def test_missing_database_reads_empty(self) -> None:
        self.assertEqual(model_changes.read(self.home / "absent.db", "s1"), [])

    def test_unreadable_database_reads_empty(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(b"not a database")
        self.assertEqual(model_changes.read(self.path, "s1"), [])


if __name__ == "__main__":
    unittest.main()
