"""Keying the run maps by the session a chat started as, not the compression tip.

Compression moves a chat on to a child session, and Hermes keys a run started afterwards on that
tip. A device that only knows the id the chat began with still has to find its run, so ``live_runs``
and ``waiting`` walk the compression chain to the root, while a delegation — which shares the
``parent_session_id`` column but is not a compaction boundary — keeps its own id.

Run: python3 -m unittest plugin.tests.test_session_run_keying -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

from plugin import sessions

MISSING = Path("/nonexistent-state-and-store")


def compression_chain(*ids: str) -> dict:
    """Hermes's session rows for a compression lineage, oldest first.

    Every session but the tip ended in ``compression`` — that is what makes its child the chat's
    continuation. The tip's own ``end_reason`` is still unset, as a live session's is.
    """
    rows = {}
    for i, session_id in enumerate(ids):
        rows[session_id] = {
            "id": session_id,
            "parent_session_id": ids[i - 1] if i else None,
            "end_reason": "compression" if i < len(ids) - 1 else None,
        }
    return rows


class FakeDB:
    """Hermes's session store, as much of it as the walk reads: ``get_session`` by id."""

    def __init__(self, rows: dict) -> None:
        self.rows = rows

    def get_session(self, session_id: str):
        return self.rows.get(session_id)


class FakeAdapter:
    """The API server's run table: what ``live_runs``/``waiting`` read off ``_run_statuses``."""

    def __init__(self, statuses: dict) -> None:
        self._run_statuses = statuses


class ChatSessionTest(unittest.TestCase):
    def test_walks_a_compression_chain_to_the_root(self) -> None:
        db = FakeDB(compression_chain("root", "c1", "tip"))
        self.assertEqual(sessions.chat_session(db, "tip"), "root")

    def test_a_delegate_child_keeps_its_own_id(self) -> None:
        # A delegate's parent is not a compaction boundary, so the walk never moves off the child.
        db = FakeDB(
            {
                "root": {"id": "root", "parent_session_id": None, "end_reason": None},
                "kid": {"id": "kid", "parent_session_id": "root", "end_reason": None},
            }
        )
        self.assertEqual(sessions.chat_session(db, "kid"), "kid")

    def test_an_unknown_session_is_returned_unchanged(self) -> None:
        self.assertEqual(sessions.chat_session(FakeDB({}), "gone"), "gone")

    def test_without_a_store_the_id_is_returned_unchanged(self) -> None:
        class NoStore:
            pass

        self.assertEqual(sessions.chat_session(NoStore(), "tip"), "tip")


class LiveRunsTest(unittest.TestCase):
    def test_keys_a_run_on_the_compression_tip_under_the_root(self) -> None:
        db = FakeDB(compression_chain("root", "tip"))
        adapter = FakeAdapter({"r1": {"status": "running", "session_id": "tip"}})
        live, run_ids = sessions.live_runs(adapter, db=db)
        self.assertEqual(live, {"root": "running"})
        self.assertEqual(run_ids, {"root": "r1"})

    def test_without_a_store_it_keeps_the_tips_own_id(self) -> None:
        # Back-compat: a caller with no session store gets today's tip keying, never a crash.
        adapter = FakeAdapter({"r1": {"status": "running", "session_id": "tip"}})
        live, run_ids = sessions.live_runs(adapter)
        self.assertEqual(live, {"tip": "running"})
        self.assertEqual(run_ids, {"tip": "r1"})

    def test_a_waiting_run_wins_a_collision_with_a_running_one(self) -> None:
        # Two runs of one chat meet under the root; the one waiting on the user is what to report.
        db = FakeDB(compression_chain("root", "tip"))
        adapter = FakeAdapter(
            {
                "r1": {"status": "running", "session_id": "tip"},
                "r2": {"status": "waiting_for_approval", "session_id": "root"},
            }
        )
        live, run_ids = sessions.live_runs(adapter, db=db)
        self.assertEqual(live, {"root": "waiting_for_approval"})
        self.assertEqual(run_ids, {"root": "r2"})


class WaitingTest(unittest.TestCase):
    def test_keys_a_clarify_on_the_tip_under_the_root(self) -> None:
        db = FakeDB(compression_chain("root", "tip"))
        adapter = FakeAdapter(
            {
                "r1": {
                    "status": "waiting_for_approval",
                    "session_id": "tip",
                    "clarify": {"questions": [{"question": "Which file?"}]},
                }
            }
        )
        found = sessions.waiting(adapter, MISSING, MISSING, db=db)
        self.assertEqual(found, {"root": {"kind": "question", "count": 1}})

    def test_keys_an_approval_on_the_tip_under_the_root(self) -> None:
        db = FakeDB(compression_chain("root", "tip"))
        adapter = FakeAdapter(
            {
                "r1": {
                    "status": "waiting_for_approval",
                    "session_id": "tip",
                    "approval": {"command": "rm -rf build"},
                }
            }
        )
        found = sessions.waiting(adapter, MISSING, MISSING, db=db)
        self.assertEqual(found, {"root": {"kind": "approval", "command": "rm -rf build"}})


if __name__ == "__main__":
    unittest.main()
