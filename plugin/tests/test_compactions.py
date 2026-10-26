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


def message(
    id: int,
    at: float,
    *,
    session: str = "s1",
    role: str = "user",
    active: int = 1,
    compacted: int = 0,
    summary: int = 0,
) -> tuple:
    """One transcript row: the flags say how the compaction left it, not how the read counts it."""
    return (id, session, role, at, active, compacted, summary)


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

    def test_a_store_from_before_in_place_compression_keeps_its_rotation_marks(self) -> None:
        # Hermes predating in-place compression has a `messages` table without the summary flag:
        # the rotation marks must still be read, not the whole answer going unknown.
        store(
            self.home,
            [
                ("s1", None, "compression", 100.0, None, None),
                ("s2", "s1", None, None, None, None),
            ],
        )
        with closing(sqlite3.connect(self.home / "state.db")) as conn:
            conn.execute(
                "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
                " timestamp REAL, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0)"
            )
            conn.commit()
        self.assertEqual(compactions.read(self.home, "s2"), [{"at": 100_000}])

    def test_an_in_place_compaction_marks_the_session_it_happened_in(self) -> None:
        # The default compression is in place (Hermes's `compression.in_place`): one session id, the
        # rows it took away soft-archived, and the summary that starts the live context flagged
        # `_compressed_summary`. There is no rotation to walk, so the flag is the only record.
        store(
            self.home,
            [("s1", None, None, None, None, None)],
            [
                message(1, 100.0, active=0, compacted=1),
                message(2, 110.0, role="assistant", active=0, compacted=1),
                message(3, 500.0, summary=1),
                message(4, 600.0, role="assistant"),
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
                message(1, 5.0, active=0, compacted=1),
                message(2, 6.0009, role="assistant", summary=1),
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
                message(1, 100.0, active=0, compacted=1),  # archived: what was summarized away
                message(2, 480.0, role="assistant", active=0),  # carried original, hidden
                message(3, 490.0, active=0),  # carried original, hidden
                message(4, 480.0, role="assistant"),  # its copy, live
                message(5, 490.0),  # its copy, live
                message(6, 500.0, summary=1),  # the summary: the compaction itself
                message(7, 600.0, role="assistant"),  # first turn written after it
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
                message(1, 100.0, active=0, compacted=1),
                message(2, 110.0, role="assistant", active=0, compacted=1),
                message(3, 500.0, active=0, compacted=1, summary=1),
                message(4, 600.0, role="assistant", active=0, compacted=1),
                message(5, 700.0, active=0, compacted=1),
                message(6, 800.0, summary=1),
                message(7, 900.0, role="assistant"),
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
                message(1, 200.0, session="s2", active=0, compacted=1),
                message(2, 300.0, session="s2", role="assistant", active=0, compacted=1),
                message(3, 700.0, session="s2", summary=1),
                message(4, 800.0, session="s2", role="assistant"),
            ],
        )
        self.assertEqual(compactions.read(self.home, "s2"), [{"at": 100_000}, {"at": 700_000}])

    def test_a_rotation_summary_is_that_rotation_not_one_more(self) -> None:
        # A rotation publishes its summary into the child as one of its first rows, flagged
        # `_compressed_summary` (hermes_state_compression.py inserts the child's rows at :452 and
        # ends the parent at :470). The walk already counts that rotation, so reading the row as a
        # second compaction splits one compaction in two — and the divider, which keeps the first
        # mark of a row, loses the size only the rotation's own mark carries.
        store(
            self.home,
            [
                ("s1", None, "compression", 100.0, None, None),
                ("s2", "s1", None, None, None, None),
            ],
            [
                message(1, 90.0, session="s2", summary=1),  # what the rotation published
                message(2, 95.0, session="s2", role="assistant"),
                message(3, 700.0, session="s2", summary=1),  # a later in-place compaction, its own
                message(4, 800.0, session="s2", role="assistant"),
            ],
        )
        self.assertEqual(compactions.read(self.home, "s2"), [{"at": 100_000}, {"at": 700_000}])

    def test_a_live_row_with_no_summary_flag_is_not_a_mark(self) -> None:
        store(
            self.home,
            [("s1", None, None, None, None, None)],
            [
                message(1, 100.0),
                message(2, 110.0, role="assistant"),
            ],
        )
        self.assertEqual(compactions.read(self.home, "s1"), [])

    def test_an_unreadable_store_is_unknown_not_empty(self) -> None:
        (self.home / "state.db").write_bytes(b"not a database")
        self.assertIsNone(compactions.read(self.home, "s1"))


if __name__ == "__main__":
    unittest.main()
