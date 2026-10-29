import sqlite3
import tempfile
import unittest
from pathlib import Path

from plugin import failed_turns


class FailedTurnTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.state = self.home / "state.db"
        conn = sqlite3.connect(self.state)
        conn.execute(
            """CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,
               content TEXT, display_kind TEXT)"""
        )
        conn.commit()
        conn.close()

    def _rows(self, rows):
        conn = sqlite3.connect(self.state)
        conn.executemany(
            "INSERT INTO messages (id, session_id, role, content, display_kind) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
        conn.close()

    def _left(self):
        conn = sqlite3.connect(self.state)
        try:
            return [r[0] for r in conn.execute("SELECT id FROM messages ORDER BY id")]
        finally:
            conn.close()

    def test_the_request_and_the_failure_go_and_the_rest_stays(self):
        self._rows(
            [
                (1, "s", "user", "earlier", None),
                (2, "s", "assistant", "fine", None),
                (3, "s", "user", "connect my office", "internal_notification"),
                (4, "s", "assistant", "Your request was not processed.", "failed_turn"),
                (5, "s", "session_meta", "", None),
                (6, "other", "user", "connect my office", None),
            ]
        )
        self.assertEqual(failed_turns.clear(self.home, "s", 4), 2)
        self.assertEqual(self._left(), [1, 2, 5, 6])

    def test_what_the_turn_wrote_between_the_request_and_the_failure_goes_too(self):
        self._rows(
            [
                (1, "s", "user", "do it", None),
                (2, "s", "assistant", "", None),
                (3, "s", "tool", "{}", None),
                (4, "s", "assistant", "gave up", "failed_turn"),
            ]
        )
        self.assertEqual(failed_turns.clear(self.home, "s", 4), 4)
        self.assertEqual(self._left(), [])

    def test_a_steer_is_not_the_turns_request(self):
        self._rows(
            [
                (1, "s", "user", "do it", None),
                (2, "s", "user", "[OUT-OF-BAND USER MESSAGE]", "steer"),
                (3, "s", "assistant", "gave up", "failed_turn"),
            ]
        )
        self.assertEqual(failed_turns.clear(self.home, "s", 3), 3)

    def test_only_a_failed_turn_of_that_session_is_cleared(self):
        self._rows(
            [
                (1, "s", "user", "ask", None),
                (2, "s", "assistant", "an answer", None),
                (3, "other", "user", "ask", None),
                (4, "other", "assistant", "no", "failed_turn"),
            ]
        )
        self.assertEqual(failed_turns.clear(self.home, "s", 2), 0)
        self.assertEqual(failed_turns.clear(self.home, "s", 4), 0)
        self.assertEqual(failed_turns.clear(self.home, "s", 99), 0)
        self.assertEqual(self._left(), [1, 2, 3, 4])

    def test_a_failure_with_no_request_above_it_is_left_alone(self):
        self._rows([(1, "s", "assistant", "no", "failed_turn")])
        self.assertEqual(failed_turns.clear(self.home, "s", 1), 0)
        self.assertEqual(self._left(), [1])

    def test_a_missing_or_unwritable_store_changes_nothing(self):
        self.assertEqual(failed_turns.clear(Path(tempfile.mkdtemp()), "s", 1), 0)
        (self.home / "state.db").unlink()
        (self.home / "state.db").write_bytes(b"not a database")
        self.assertEqual(failed_turns.clear(self.home, "s", 1), 0)


if __name__ == "__main__":
    unittest.main()
