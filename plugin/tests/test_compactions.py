"""The compactions a chat's thread marks, read from Hermes's own store: the session lineage a
rotation leaves, and the transcript an in-place compaction soft-archives under the same session.

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


def store(home: Path, rows, messages=()) -> None:
    with closing(sqlite3.connect(home / "state.db")) as conn:
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT,"
            " ended_at REAL, model_config TEXT, source TEXT)"
        )
        conn.executemany("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", rows)
        if messages:
            # The columns an in-place compaction writes, in Hermes's own names and order.
            conn.execute(
                "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
                " timestamp REAL, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0,"
                " _compressed_summary INTEGER DEFAULT 0)"
            )
            conn.executemany("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)", messages)
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

    def test_an_in_place_compaction_marks_the_session_it_happened_in(self) -> None:
        # The default compression is in place (Hermes's `compression.in_place`): one session id, the
        # rows it took away soft-archived, and the summary that starts the live context flagged
        # `_compressed_summary`. There is no rotation to walk, so the flag is the only record.
        store(
            self.home,
            [("s1", None, None, None, None, None)],
            [
                (1, "s1", "user", 100.0, 0, 1, 0),
                (2, "s1", "assistant", 110.0, 0, 1, 0),
                (3, "s1", "user", 500.0, 1, 0, 1),
                (4, "s1", "assistant", 600.0, 1, 0, 0),
            ],
        )
        # The mark is the summary's own time — the moment the compaction ran — so the divider
        # lands above the first turn written after it, with the summary and everything older on
        # the side that was compacted, on any device.
        self.assertEqual(compactions.read(self.home, "s1"), [{"at": 500_000}])

    def test_a_mark_is_the_rows_time_as_the_app_rounds_it(self) -> None:
        # The app turns a row's own timestamp into ms with Math.round (history.ts), and the mark
        # has to be the summary row's time to that same millisecond: a truncated mark sits under
        # the summary's own ms and flips it across the divider, a row early or late. Caught on a
        # real store, where half the summaries would land on a fractional ms.
        store(
            self.home,
            [("s1", None, None, None, None, None)],
            [
                (1, "s1", "user", 5.0, 0, 1, 0),
                (2, "s1", "assistant", 6.0009, 1, 0, 1),
            ],
        )
        self.assertEqual(
            compactions.read(self.home, "s1"),
            [{"at": 6001}],  # 6.0009 s is 6000.9 ms: 6001 rounded, 6000 truncated
        )

    def test_a_mark_is_the_compaction_moment_not_the_end_of_the_archived_rows(self) -> None:
        # A real store keeps the turns a compaction carried live — its originals hidden rather than
        # archived (`active = 0`, `compacted = 0`), their copies under fresh ids — and those run
        # right up to the moment the compaction happened. Dating the mark to the last archived row
        # would drop the divider minutes early, inside the turns it carried.
        store(
            self.home,
            [("s1", None, None, None, None, None)],
            [
                (1, "s1", "user", 100.0, 0, 1, 0),  # archived: what was summarized away
                (2, "s1", "assistant", 480.0, 0, 0, 0),  # carried original, hidden
                (3, "s1", "user", 490.0, 0, 0, 0),  # carried original, hidden
                (4, "s1", "assistant", 480.0, 1, 0, 0),  # its copy, live
                (5, "s1", "user", 490.0, 1, 0, 0),  # its copy, live
                (6, "s1", "user", 500.0, 1, 0, 1),  # the summary: the compaction itself
                (7, "s1", "assistant", 600.0, 1, 0, 0),  # first turn written after it
            ],
        )
        self.assertEqual(compactions.read(self.home, "s1"), [{"at": 500_000}])

    def test_each_in_place_compaction_is_one_mark_oldest_first(self) -> None:
        # A second compaction archives the first summary with everything else, so its own summary is
        # what marks it.
        store(
            self.home,
            [("s1", None, None, None, None, None)],
            [
                (1, "s1", "user", 100.0, 0, 1, 0),
                (2, "s1", "assistant", 110.0, 0, 1, 0),
                (3, "s1", "user", 500.0, 0, 1, 1),
                (4, "s1", "assistant", 600.0, 0, 1, 0),
                (5, "s1", "user", 700.0, 0, 1, 0),
                (6, "s1", "user", 800.0, 1, 0, 1),
                (7, "s1", "assistant", 900.0, 1, 0, 0),
            ],
        )
        self.assertEqual(compactions.read(self.home, "s1"), [{"at": 500_000}, {"at": 800_000}])

    def test_in_place_marks_and_a_rotation_merge_oldest_first(self) -> None:
        # A host that rotated once and then compacted in place: the lineage's rotation and the
        # transcript's own marks are one list, oldest first.
        store(
            self.home,
            [
                ("s1", None, "compression", 100.0, None, None),
                ("s2", "s1", None, None, None, None),
            ],
            [
                (1, "s2", "user", 200.0, 0, 1, 0),
                (2, "s2", "assistant", 300.0, 0, 1, 0),
                (3, "s2", "user", 700.0, 1, 0, 1),
                (4, "s2", "assistant", 800.0, 1, 0, 0),
            ],
        )
        self.assertEqual(compactions.read(self.home, "s2"), [{"at": 100_000}, {"at": 700_000}])

    def test_a_session_with_no_compaction_marks_nothing(self) -> None:
        store(
            self.home,
            [("s1", None, None, None, None, None)],
            [
                (1, "s1", "user", 100.0, 1, 0, 0),
                (2, "s1", "assistant", 110.0, 1, 0, 0),
            ],
        )
        self.assertEqual(compactions.read(self.home, "s1"), [])

    def test_an_unreadable_store_is_unknown_not_empty(self) -> None:
        (self.home / "state.db").write_bytes(b"not a database")
        self.assertIsNone(compactions.read(self.home, "s1"))


if __name__ == "__main__":
    unittest.main()
