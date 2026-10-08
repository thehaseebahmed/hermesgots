"""Listing the sessions a session delegated to, from Hermes's state.db.

Run: python3 -m unittest plugin.tests.test_delegation_children -v
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from plugin import delegation


class ChildrenTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.conn = sqlite3.connect(self.home / "state.db")
        self.conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, model_config TEXT, parent_session_id TEXT,"
            " started_at REAL, ended_at REAL, end_reason TEXT, tool_call_count INTEGER DEFAULT 0)"
        )
        self.conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT)")
        self.clock = 0.0

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def session(self, sid: str, parent: str | None = None, *, delegate_from: str | None = None,
                ended: bool = False, reason: str | None = None, calls: int = 0, goal: str | None = None) -> None:
        self.clock += 1
        config = json.dumps({"_delegate_from": delegate_from}) if delegate_from else None
        self.conn.execute(
            "INSERT INTO sessions VALUES (?, 'm', ?, ?, ?, ?, ?, ?)",
            (sid, config, parent, self.clock, self.clock if ended else None, reason, calls),
        )
        if goal:
            self.conn.execute("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)", (sid, goal))
        self.conn.commit()

    def test_lists_the_delegations_with_their_goal(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s", ended=True, reason="agent_close", calls=3, goal="Build  CP1\nnow")
        self.session("other")
        self.session("c2", "other", delegate_from="other", ended=True)
        found = delegation.children(self.home, "s", set())
        self.assertEqual([c["id"] for c in found], ["c1"])
        self.assertEqual(found[0]["goal"], "Build CP1 now")
        self.assertEqual(found[0]["status"], "done")
        self.assertEqual(found[0]["tool_calls"], 3)

    def test_follows_the_session_through_compression(self) -> None:
        self.session("s", ended=True, reason="compression")
        self.session("tip", "s")
        self.session("c1", "tip", delegate_from="tip", ended=True)
        self.assertEqual([c["id"] for c in delegation.children(self.home, "s", set())], ["c1"])

    def test_a_compressed_child_counts_once(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s", ended=True, reason="compression", calls=2)
        # Compression copies model_config, so the continuation carries the same marker.
        self.session("c1b", "c1", delegate_from="s", calls=4)
        found = delegation.children(self.home, "s", {"s"})
        self.assertEqual([c["id"] for c in found], ["c1"])
        self.assertEqual(found[0]["status"], "running")
        self.assertEqual(found[0]["tool_calls"], 6)

    def test_an_open_child_is_stopped_once_the_parent_run_is_gone(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.assertEqual(delegation.children(self.home, "s", set())[0]["status"], "stopped")
        self.assertEqual(delegation.children(self.home, "s", {"s"})[0]["status"], "running")

    def test_no_store_means_no_children(self) -> None:
        self.assertEqual(delegation.children(self.home / "missing", "s", set()), [])


if __name__ == "__main__":
    unittest.main()
