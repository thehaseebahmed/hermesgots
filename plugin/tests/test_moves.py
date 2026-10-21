"""Moved markers: a triage move is recorded on the host and read back with Main's history.

Run: python3 -m unittest plugin.tests.test_moves -v
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from plugin import moves
from plugin.store import SCHEMA_VERSION, connect, db_path


class MovesTests(unittest.TestCase):
    def setUp(self):
        self.path = db_path(Path(tempfile.mkdtemp()))

    def test_a_move_is_recorded_and_read_back(self):
        moves.record(self.path, "m1", "main-s", "more on Lisbon", "t1")
        found = moves.read(self.path, "main-s")
        self.assertEqual(len(found), 1)
        self.assertEqual(
            {k: found[0][k] for k in ("id", "text", "thread", "undone")},
            {"id": "m1", "text": "more on Lisbon", "thread": "t1", "undone": False},
        )
        self.assertGreater(found[0]["at"], 0)

    def test_oldest_first_and_per_main_session(self):
        moves.record(self.path, "m1", "main-s", "first", "t1")
        moves.record(self.path, "m2", "main-s", "second", "t2")
        moves.record(self.path, "m3", "other-main", "elsewhere", "t3")
        self.assertEqual([m["id"] for m in moves.read(self.path, "main-s")], ["m1", "m2"])
        self.assertEqual([m["id"] for m in moves.read(self.path, "other-main")], ["m3"])

    def test_a_repeated_ask_is_one_move(self):
        for _ in range(2):
            moves.record(self.path, "m1", "main-s", "again", "t1")
        self.assertEqual(len(moves.read(self.path, "main-s")), 1)

    def test_a_message_that_stayed_leaves_nothing(self):
        self.assertEqual(moves.read(self.path, "main-s"), [])
        moves.record(self.path, None, "main-s", "no id", "t1")
        self.assertEqual(moves.read(self.path, "main-s"), [])

    def test_undone_is_read_back(self):
        moves.record(self.path, "m1", "main-s", "x", "t1")
        conn = connect(self.path)
        conn.execute("UPDATE main_moves SET undone = 1")
        conn.close()
        self.assertTrue(moves.read(self.path, "main-s")[0]["undone"])

    def test_survives_a_restart(self):
        moves.record(self.path, "m1", "main-s", "kept", "t1")
        # A restart is a new connection to the same file, and a store from before the table gains it.
        self.assertEqual(moves.read(self.path, "main-s")[0]["text"], "kept")
        old = db_path(Path(tempfile.mkdtemp()))
        old.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(old)
        conn.execute("PRAGMA user_version = 31")
        conn.close()
        self.assertEqual(moves.read(old, "main-s"), [])
        moves.record(old, "m1", "main-s", "x", "t1")
        self.assertEqual(len(moves.read(old, "main-s")), 1)
        self.assertEqual(sqlite3.connect(old).execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_a_v32_store_keeps_its_moves_and_drops_thread_session(self):
        old = db_path(Path(tempfile.mkdtemp()))
        old.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(old)
        conn.execute(
            """CREATE TABLE main_moves (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
               text TEXT NOT NULL, thread TEXT NOT NULL, thread_session TEXT NOT NULL,
               at INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0)"""
        )
        conn.execute("INSERT INTO main_moves VALUES ('m0', 'main-s', 'kept', 't1', 's1', 5, 0)")
        conn.execute("PRAGMA user_version = 32")
        conn.commit()
        conn.close()
        self.assertEqual([m["id"] for m in moves.read(old, "main-s")], ["m0"])
        moves.record(old, "m1", "main-s", "new", "t2")
        self.assertEqual([m["id"] for m in moves.read(old, "main-s")], ["m0", "m1"])


if __name__ == "__main__":
    unittest.main()
