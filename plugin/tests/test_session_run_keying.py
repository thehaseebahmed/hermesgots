"""Keying the run maps by the session a chat started as, not the compression tip.

Compression moves a chat on to a child session, and Hermes keys a run started afterwards on that
tip. A device that only knows the id the chat began with still has to find its run, so ``live_runs``
and ``waiting`` walk the compression chain to the root, while a delegation — which shares the
``parent_session_id`` column but is not a compaction boundary — keeps its own id.

The walk reads the profile's ``state.db`` itself, read-only, and never ``SessionDB.get_session``:
the app polls ``runs/live`` every 10 s while a turn runs, and that read drains the live turn's
queued token writes (blocking up to 5 s a call), so a poll through it stalls every read the API
server's shared executor carries behind it — the streaming chat it was asked about included.

Run: python3 -m unittest plugin.tests.test_session_run_keying -v
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

from plugin import sessions

MISSING = Path("/nonexistent-state-and-store")


def store(home: Path, rows: Iterable[Tuple[str, Optional[str], Optional[str]]]) -> Path:
    """A Hermes ``state.db`` holding these sessions: ``(id, parent_session_id, end_reason)``."""
    home.mkdir(parents=True, exist_ok=True)
    path = home / "state.db"
    with closing(sqlite3.connect(path)) as conn:
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT)"
        )
        conn.executemany("INSERT INTO sessions VALUES (?, ?, ?)", list(rows))
        conn.commit()
    return path


def compression_chain(*ids: str) -> List[Tuple[str, Optional[str], Optional[str]]]:
    """Hermes's session rows for a compression lineage, oldest first.

    Every session but the tip ended in ``compression`` — that is what makes its child the chat's
    continuation. The tip's own ``end_reason`` is still unset, as a live session's is.
    """
    return [
        (session_id, ids[i - 1] if i else None, "compression" if i < len(ids) - 1 else None)
        for i, session_id in enumerate(ids)
    ]


class TempHome(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)


class FakeAdapter:
    """The API server's run table: what ``live_runs``/``waiting`` read off ``_run_statuses``."""

    def __init__(self, statuses: dict) -> None:
        self._run_statuses = statuses


class ChatSessionTest(TempHome):
    def test_walks_a_compression_chain_to_the_root(self) -> None:
        path = store(self.home, compression_chain("root", "c1", "tip"))
        self.assertEqual(sessions.chat_session(path, "tip"), "root")

    def test_a_delegate_child_keeps_its_own_id(self) -> None:
        # A delegate's parent is not a compaction boundary, so the walk never moves off the child.
        path = store(self.home, [("root", None, None), ("kid", "root", None)])
        self.assertEqual(sessions.chat_session(path, "kid"), "kid")

    def test_an_unknown_session_is_returned_unchanged(self) -> None:
        path = store(self.home, compression_chain("root", "tip"))
        self.assertEqual(sessions.chat_session(path, "gone"), "gone")

    def test_without_a_store_the_id_is_returned_unchanged(self) -> None:
        self.assertEqual(sessions.chat_session(MISSING, "tip"), "tip")

    def test_an_unreadable_store_answers_the_id_it_was_given(self) -> None:
        path = self.home / "state.db"
        path.write_bytes(b"not a database")
        self.assertEqual(sessions.chat_session(path, "tip"), "tip")


class LiveRunsTest(TempHome):
    def test_keys_a_run_on_the_compression_tip_under_the_root(self) -> None:
        store(self.home, compression_chain("root", "tip"))
        adapter = FakeAdapter({"r1": {"status": "running", "session_id": "tip"}})
        live, run_ids = sessions.live_runs(adapter, home=self.home)
        self.assertEqual(live, {"root": "running"})
        self.assertEqual(run_ids, {"root": "r1"})

    def test_without_a_store_it_keeps_the_tips_own_id(self) -> None:
        # Back-compat: a caller with no home gets today's tip keying, never a crash.
        adapter = FakeAdapter({"r1": {"status": "running", "session_id": "tip"}})
        live, run_ids = sessions.live_runs(adapter)
        self.assertEqual(live, {"tip": "running"})
        self.assertEqual(run_ids, {"tip": "r1"})

    def test_a_waiting_run_wins_a_collision_with_a_running_one(self) -> None:
        # Two runs of one chat meet under the root; the one waiting on the user is what to report.
        store(self.home, compression_chain("root", "tip"))
        adapter = FakeAdapter(
            {
                "r1": {"status": "running", "session_id": "tip"},
                "r2": {"status": "waiting_for_approval", "session_id": "root"},
            }
        )
        live, run_ids = sessions.live_runs(adapter, home=self.home)
        self.assertEqual(live, {"root": "waiting_for_approval"})
        self.assertEqual(run_ids, {"root": "r2"})


class WaitingTest(TempHome):
    def test_keys_a_clarify_on_the_tip_under_the_root(self) -> None:
        store(self.home, compression_chain("root", "tip"))
        adapter = FakeAdapter(
            {
                "r1": {
                    "status": "waiting_for_approval",
                    "session_id": "tip",
                    "clarify": {"questions": [{"question": "Which file?"}]},
                }
            }
        )
        found = sessions.waiting(adapter, MISSING, self.home)
        self.assertEqual(found, {"root": {"kind": "question", "count": 1}})

    def test_keys_an_approval_on_the_tip_under_the_root(self) -> None:
        store(self.home, compression_chain("root", "tip"))
        adapter = FakeAdapter(
            {
                "r1": {
                    "status": "waiting_for_approval",
                    "session_id": "tip",
                    "approval": {"command": "rm -rf build"},
                }
            }
        )
        found = sessions.waiting(adapter, MISSING, self.home)
        self.assertEqual(found, {"root": {"kind": "approval", "command": "rm -rf build"}})


if __name__ == "__main__":
    unittest.main()
