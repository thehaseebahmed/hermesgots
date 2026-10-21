"""The compactions a chat's thread marks, read from Hermes's own session lineage.

Run: python3 -m unittest plugin.tests.test_compactions -v
"""

from __future__ import annotations

import json
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path

from plugin import compactions
from plugin.store import connect, db_path
from plugin.tests._helpers import temp_hermes_home


def store(home: Path, rows) -> None:
    with closing(sqlite3.connect(home / "state.db")) as conn:
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT,"
            " ended_at REAL, model_config TEXT, source TEXT)"
        )
        conn.executemany("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", rows)
        conn.commit()


class CompactionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)

    def test_no_state_store_is_no_compactions(self) -> None:
        self.assertEqual(compactions.read(self.home, "s1"), [])

    def test_each_ended_parent_is_one_compaction_oldest_first(self) -> None:
        store(
            self.home,
            [
                ("s1", None, "compression", 100.5, None, None),
                ("s2", "s1", "compression", 200.0, None, None),
                ("s3", "s2", None, None, None, None),
            ],
        )
        self.assertEqual(compactions.read(self.home, "s3"), [{"at": 100500}, {"at": 200000}])

    def test_a_compaction_carries_the_parents_last_size_where_recorded(self) -> None:
        store(
            self.home,
            [
                ("s1", None, "compression", 100.0, None, None),
                ("s2", "s1", "compression", 200.0, None, None),
                ("s3", "s2", None, None, None, None),
            ],
        )
        conn = connect(db_path(self.home))
        conn.execute(
            "INSERT INTO context (session_id, prompt_tokens, context_length, at) "
            "VALUES ('s1', 168000, 200000, 1)"
        )
        conn.execute(
            "INSERT INTO context (session_id, prompt_tokens, at) VALUES ('s3', 5000, 2)"
        )
        conn.commit()
        conn.close()
        self.assertEqual(
            compactions.read(self.home, "s3"),
            [{"at": 100000, "tokens": 168000, "window": 200000}, {"at": 200000}],
        )

    def test_an_uncompacted_chat_has_none(self) -> None:
        store(self.home, [("s1", None, None, None, None, None)])
        self.assertEqual(compactions.read(self.home, "s1"), [])

    def test_a_parent_that_ended_for_another_reason_is_not_one(self) -> None:
        store(
            self.home,
            [("s1", None, "user_exit", 100.0, None, None), ("s2", "s1", None, None, None, None)],
        )
        self.assertEqual(compactions.read(self.home, "s2"), [])

    def test_a_delegated_child_is_another_conversation(self) -> None:
        store(
            self.home,
            [
                ("s1", None, "compression", 100.0, None, None),
                ("s2", "s1", None, None, json.dumps({"_delegate_from": "s1"}), None),
            ],
        )
        self.assertEqual(compactions.read(self.home, "s2"), [])

    def test_an_unreadable_store_is_unknown_not_empty(self) -> None:
        (self.home / "state.db").write_bytes(b"not a database")
        self.assertIsNone(compactions.read(self.home, "s1"))


if __name__ == "__main__":
    unittest.main()
