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


class UndoTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.path = db_path(self.home)
        self.body = {"input": [{"role": "user", "content": "hi"}], "session_id": "main-s"}

    def _move(self, **extra):
        moves.record(
            self.path, "m1", "main-s", "more on Lisbon", "t1",
            thread_session="memento-t1", item="q_1", body=self.body, **extra
        )
        return moves.get(self.path, "main-s", "m1")

    def test_what_undo_needs_is_kept(self):
        move = self._move(new=True, files=[{"name": "a.txt"}])
        self.assertEqual(
            (move["thread_session"], move["item"], move["new"], move["body"], move["files"]),
            ("memento-t1", "q_1", True, self.body, [{"name": "a.txt"}]),
        )

    def test_phase_follows_the_threads_reply(self):
        queued = {"run_id": None}
        sent = {"run_id": "r1"}
        self.assertEqual(moves.phase(queued, None), moves.QUEUED)
        self.assertEqual(moves.phase(sent, {"status": "running"}), moves.RUNNING)
        self.assertEqual(moves.phase(sent, {"status": "waiting_for_approval"}), moves.RUNNING)
        self.assertEqual(moves.phase(sent, {"status": "cancelled"}), moves.STOPPED)
        self.assertEqual(moves.phase(sent, {"status": "completed"}), moves.REPLIED)
        self.assertEqual(moves.phase(sent, None), moves.REPLIED)
        self.assertEqual(moves.phase(None, None), moves.REPLIED)

    def test_undo_is_open_until_the_reply_finishes(self):
        move = self._move()
        for where in (moves.QUEUED, moves.RUNNING, moves.STOPPED):
            self.assertTrue(moves.undoable(move, where))
        self.assertFalse(moves.undoable(move, moves.REPLIED))

    def test_undone_and_unrecoverable_moves_are_refused(self):
        move = self._move()
        moves.mark_undone(self.path, "m1")
        self.assertTrue(moves.read(self.path, "main-s")[0]["undone"])
        self.assertFalse(moves.undoable(moves.get(self.path, "main-s", "m1"), moves.QUEUED))
        moves.record(self.path, "m2", "main-s", "no body", "t2", thread_session="s", item="q")
        self.assertFalse(moves.undoable(moves.get(self.path, "main-s", "m2"), moves.QUEUED))
        self.assertIsNone(moves.get(self.path, "other", "m1"))

    def _transcript(self, rows):
        state = self.home / "state.db"
        conn = sqlite3.connect(state)
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)"
        )
        conn.executemany(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)", rows
        )
        conn.commit()
        conn.close()
        return state

    def _left(self, state):
        return sqlite3.connect(state).execute("SELECT session_id, content FROM messages ORDER BY id").fetchall()

    def test_the_message_leaves_the_threads_transcript(self):
        state = self._transcript(
            [
                ("memento-t1", "user", "earlier", 90),
                ("memento-t1", "assistant", "ok", 91),
                ("memento-t1", "user", '<attachment name="a" />\nmore on Lisbon', 100),
                ("memento-t1", "assistant", "partial", 101),
                ("other", "user", "more on Lisbon", 100),
            ]
        )
        self.assertEqual(moves.take_from_transcript(self.home, "memento-t1", "more on Lisbon", 99_000), 2)
        self.assertEqual(
            self._left(state),
            [("memento-t1", "earlier"), ("memento-t1", "ok"), ("other", "more on Lisbon")],
        )
        self.assertEqual(moves.take_from_transcript(self.home, "memento-t1", "absent"), 0)
        self.assertEqual(moves.take_from_transcript(Path(tempfile.mkdtemp()), "x", "y"), 0)

    def test_the_transcript_is_left_alone_unless_the_message_is_certain(self):
        state = self._transcript(
            [
                ("memento-t1", "user", "ok", 10),
                ("memento-t1", "assistant", "fine", 11),
                ("memento-t1", "user", "okay, and also this", 200),
                ("memento-t1", "assistant", "reply", 201),
            ]
        )
        # A substring of a later message, and an older exact match, are not the moved message.
        self.assertEqual(moves.take_from_transcript(self.home, "memento-t1", "ok", 150_000), 0)
        self.assertEqual(moves.take_from_transcript(self.home, "memento-t1", "okay", 150_000), 0)
        self.assertEqual(len(self._left(state)), 4)
        # Neither is the thread's newest user row when it was written before the item was sent.
        self.assertEqual(moves.take_from_transcript(self.home, "memento-t1", "okay, and also this", 500_000), 0)
        self.assertEqual(len(self._left(state)), 4)

    def test_a_list_read_does_not_load_bodies_and_old_ones_are_dropped(self):
        self._move()
        listed = moves.read(self.path, "main-s")[0]
        self.assertIs(listed["body"], True)
        self.assertEqual(listed["files"], [])
        conn = connect(self.path)
        conn.execute("UPDATE main_moves SET at = 1")
        conn.close()
        moves.record(self.path, "m2", "main-s", "fresh", "t2", thread_session="s", item="q", body=self.body)
        self.assertIsNone(moves.get(self.path, "main-s", "m1")["body"])
        self.assertEqual(moves.get(self.path, "main-s", "m2")["body"], self.body)

    def test_phase_ignores_a_status_that_is_not_a_record(self):
        self.assertEqual(moves.phase({"run_id": "r"}, "running"), moves.REPLIED)

    def test_a_v33_store_gains_the_columns(self):
        old = db_path(Path(tempfile.mkdtemp()))
        old.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(old)
        conn.execute(
            """CREATE TABLE main_moves (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
               text TEXT NOT NULL, thread TEXT NOT NULL, at INTEGER NOT NULL,
               undone INTEGER NOT NULL DEFAULT 0)"""
        )
        conn.execute("INSERT INTO main_moves VALUES ('m0', 'main-s', 'kept', 't1', 5, 0)")
        conn.execute("PRAGMA user_version = 33")
        conn.commit()
        conn.close()
        self.assertEqual(moves.get(old, "main-s", "m0")["item"], None)
        self.assertEqual([m["id"] for m in moves.read(old, "main-s")], ["m0"])


class RemoveSentTests(unittest.TestCase):
    def test_a_sent_item_is_forgotten_and_a_waiting_one_is_not(self):
        from plugin import outbox

        path = db_path(Path(tempfile.mkdtemp()))
        body = {"input": [{"role": "user", "content": "x"}]}
        waiting = outbox.add(path, "s", None, "x", [], body)
        sent = outbox.add(path, "s", None, "y", [], body)
        outbox.mark(path, sent["id"], run_id="r1")
        self.assertFalse(outbox.remove_sent(path, "s", waiting["id"]))
        self.assertTrue(outbox.remove_sent(path, "s", sent["id"]))
        self.assertEqual([i["id"] for i in outbox.read(path, "s")["items"]], [waiting["id"]])
        self.assertEqual(outbox.read(path, "s")["sent"], [])


if __name__ == "__main__":
    unittest.main()
