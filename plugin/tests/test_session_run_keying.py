"""Keying the run maps by the session a chat started as, not the compression tip.

Compression moves a chat on to a child session, and Hermes keys a run started afterwards on that
tip. A device that only knows the id the chat began with still has to find its run, so ``live_runs``
and ``waiting`` walk the compression chain to the root — following only a parent whose own turn
ended in compression, and only a child that continues it, since a branch, a delegation, a reset and
a tool session share the ``parent_session_id`` column without being the same conversation.

The walk reads the profile's ``state.db`` itself, read-only, and never ``SessionDB.get_session``:
the app polls ``runs/live`` every 10 s while a turn runs, and that read drains the live turn's
queued token writes (blocking up to 5 s a call), so a poll through it stalls every read the API
server's shared executor carries behind it — the streaming chat it was asked about included.

Run: python3 -m unittest plugin.tests.test_session_run_keying -v
"""

from __future__ import annotations

import json
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from plugin import sessions
from plugin.tests._helpers import temp_hermes_home

MISSING = Path("/nonexistent-state-and-store")


def session(
    session_id: str, parent: Optional[str] = None, end_reason: Optional[str] = None, **fields: Any
) -> Dict[str, Any]:
    """One row of Hermes's ``sessions`` table."""
    return {"id": session_id, "parent_session_id": parent, "end_reason": end_reason, **fields}


def store(home: Path, rows: Iterable[Dict[str, Any]]) -> Path:
    """A Hermes ``state.db`` holding these sessions."""
    home.mkdir(parents=True, exist_ok=True)
    path = home / "state.db"
    with closing(sqlite3.connect(path)) as conn:
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT,"
            " model_config TEXT, source TEXT)"
        )
        conn.executemany(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
            [
                (
                    row["id"],
                    row["parent_session_id"],
                    row["end_reason"],
                    json.dumps(row["model_config"]) if row.get("model_config") else None,
                    row.get("source"),
                )
                for row in rows
            ],
        )
        conn.commit()
    return path


def compression_chain(*ids: str) -> List[Dict[str, Any]]:
    """Hermes's rows for a compression lineage, oldest first.

    Every session but the tip ended in ``compression`` — that is what makes its child the chat's
    continuation. The tip's own ``end_reason`` is still unset, as a live session's is.
    """
    return [
        session(session_id, ids[i - 1] if i else None, "compression" if i < len(ids) - 1 else None)
        for i, session_id in enumerate(ids)
    ]


class TempHome(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        # The walk warns once per process; each case starts unheard.
        sessions._walk_failed = False


class FakeAdapter:
    """The API server's run table: what ``live_runs``/``waiting`` read off ``_run_statuses``."""

    def __init__(self, statuses: dict) -> None:
        self._run_statuses = statuses


class ChatSessionTest(TempHome):
    def test_walks_a_compression_chain_to_the_root(self) -> None:
        store(self.home, compression_chain("root", "c1", "tip"))
        self.assertEqual(sessions.chat_session(self.home, "tip"), "root")

    def test_walks_a_chain_far_deeper_than_a_handful(self) -> None:
        # Hermes has met real lineages 180 compressions deep; stopping short keys the run on a
        # mid-chain id, which is the wedge this walk prevents.
        store(self.home, compression_chain("root", *[f"c{i}" for i in range(40)]))
        self.assertEqual(sessions.chat_session(self.home, "c39"), "root")

    def test_a_delegate_child_keeps_its_own_id(self) -> None:
        # The chat compressed, then delegated: the child names its parent, so it is a fork.
        store(
            self.home,
            [
                session("root", end_reason="compression"),
                session("kid", "root", model_config={"_delegate_from": "root"}),
            ],
        )
        self.assertEqual(sessions.chat_session(self.home, "kid"), "kid")

    def test_a_marker_naming_another_row_is_inherited_not_a_fork(self) -> None:
        # A continuation carries its parent's model_config verbatim, so a marker for a row that
        # isn't this parent says nothing about this hop (Hermes's _non_continuation_child_sql).
        store(
            self.home,
            [
                session("root", end_reason="compression"),
                session("tip", "root", model_config={"_delegate_from": "elsewhere"}),
            ],
        )
        self.assertEqual(sessions.chat_session(self.home, "tip"), "root")

    def test_a_tool_session_keeps_its_own_id(self) -> None:
        store(
            self.home,
            [session("root", end_reason="compression"), session("tool", "root", source="tool")],
        )
        self.assertEqual(sessions.chat_session(self.home, "tool"), "tool")

    def test_an_unknown_session_is_returned_unchanged(self) -> None:
        store(self.home, compression_chain("root", "tip"))
        self.assertEqual(sessions.chat_session(self.home, "gone"), "gone")

    def test_without_a_store_the_id_is_returned_unchanged(self) -> None:
        self.assertEqual(sessions.chat_session(MISSING, "tip"), "tip")

    def test_an_unreadable_store_answers_the_id_it_was_given(self) -> None:
        (self.home / "state.db").write_bytes(b"not a database")
        # Said once, loudly: a store this can't read silently keys runs on their tip.
        with self.assertLogs(sessions.logger, level="WARNING"):
            self.assertEqual(sessions.chat_session(self.home, "tip"), "tip")

    def test_the_memo_answers_every_id_the_walk_passed(self) -> None:
        store(self.home, compression_chain("root", "c1", "tip"))
        known: Dict[str, str] = {}
        self.assertEqual(sessions.chat_session(self.home, "tip", known), "root")
        self.assertEqual(known, {"root": "root", "c1": "root", "tip": "root"})
        # A second run of the same chat answers from the memo, without the store.
        self.assertEqual(sessions.chat_session(MISSING, "c1", known), "root")


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

    def test_the_polls_memo_carries_over_from_live_runs(self) -> None:
        # One poll reads both maps; the second call must not need the store again.
        store(self.home, compression_chain("root", "tip"))
        adapter = FakeAdapter(
            {
                "r1": {"status": "running", "session_id": "tip"},
                "r2": {
                    "status": "waiting_for_approval",
                    "session_id": "tip",
                    "approval": {"command": "npm test"},
                },
            }
        )
        known: Dict[str, str] = {}
        sessions.live_runs(adapter, home=self.home, known=known)
        found = sessions.waiting(adapter, MISSING, MISSING, known=known)
        self.assertEqual(found, {"root": {"kind": "approval", "command": "npm test"}})


if __name__ == "__main__":
    unittest.main()
