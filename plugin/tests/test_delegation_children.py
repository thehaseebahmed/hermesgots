"""Listing the sessions a session delegated to, from Hermes's state.db.

A child's own row says when it ended, never whether it is still at work: a background delegation
outlives the turn that dispatched it, so an open row is live only while this process still holds the
child (``tools/delegate_tool_registry._active_subagents``), whatever its parent's turn is doing —
and a row left open by a restart reads stopped, because nothing holds it any more.

Run: python3 -m unittest plugin.tests.test_delegation_children -v
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Dict, Optional
from unittest import mock

from plugin import delegation


class ChildrenTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.conn = sqlite3.connect(self.home / "state.db")
        self.conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, model_config TEXT, parent_session_id TEXT,"
            " started_at REAL, ended_at REAL, end_reason TEXT, tool_call_count INTEGER DEFAULT 0, source TEXT)"
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
            "INSERT INTO sessions VALUES (?, 'm', ?, ?, ?, ?, ?, ?, NULL)",
            (sid, config, parent, self.clock, self.clock if ended else None, reason, calls),
        )
        if goal:
            self.conn.execute("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)", (sid, goal))
        self.conn.commit()

    def plant(self, live: Optional[Dict[str, str]] = None) -> None:
        """Core's registry of the children this process still works on.

        ``live`` is child session id -> the conversation it was dispatched from (its
        ``owner_agent_session_id``). The record's live agent is where core writes the child's own
        session id — the one a row in ``state.db`` is keyed by, and the one ``delegation.stop``
        reads it by too. Planted in ``sys.modules``: this machine has no ``tools`` package, and the
        plugin imports core lazily so it loads on a host without it.
        """
        registry = ModuleType("tools.delegate_tool_registry")
        setattr(
            registry,
            "_active_subagents",
            {
                f"sa-{child}": {
                    "agent": SimpleNamespace(session_id=child),
                    "owner_agent_session_id": owner,
                }
                for child, owner in (live or {}).items()
            },
        )
        tools = ModuleType("tools")
        setattr(tools, "delegate_tool_registry", registry)
        patching = mock.patch.dict(
            sys.modules, {"tools": tools, "tools.delegate_tool_registry": registry}
        )
        patching.start()
        self.addCleanup(patching.stop)

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

    def test_an_open_child_its_parent_run_still_covers_reads_running(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.assertEqual(delegation.children(self.home, "s", {"s"})[0]["status"], "running")

    def test_a_subagent_still_working_after_its_parent_turn_ended_reads_running(self) -> None:
        # The turn ended when its delegation was dispatched; the child carries on writing.
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.plant({"c1": "s"})
        self.assertEqual(delegation.children(self.home, "s", set())[0]["status"], "running")

    def test_a_row_left_open_by_a_restart_reads_stopped(self) -> None:
        # A restart loses the registry and the row never got a close: the child is gone, and its
        # card must not claim it still works.
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.plant({})
        self.assertEqual(delegation.children(self.home, "s", set())[0]["status"], "stopped")

    def test_only_the_child_the_process_holds_reads_running(self) -> None:
        self.session("s")
        self.session("held", "s", delegate_from="s")
        self.session("gone", "s", delegate_from="s")
        self.plant({"held": "s"})
        found = {c["id"]: c["status"] for c in delegation.children(self.home, "s", set())}
        self.assertEqual(found, {"held": "running", "gone": "stopped"})

    def test_a_child_that_wrote_its_end_is_done_whatever_holds_it(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s", ended=True, reason="agent_close")
        self.plant({"c1": "s"})
        self.assertEqual(delegation.children(self.home, "s", set())[0]["status"], "done")

    def test_live_subagents_count_under_the_chat_that_dispatched_them(self) -> None:
        # A chat that compressed dispatches from its tip, while the app knows it by its root.
        self.session("s", ended=True, reason="compression")
        self.session("tip", "s")
        self.session("c1", "tip", delegate_from="tip")
        self.session("c2", "tip", delegate_from="tip")
        self.session("elsewhere")
        self.session("d1", "elsewhere", delegate_from="elsewhere")
        self.plant({"c1": "tip", "c2": "tip", "d1": "elsewhere"})
        self.assertEqual(delegation.live_sessions(self.home), {"s": 2, "elsewhere": 1})

    def test_nothing_held_means_no_live_subagents(self) -> None:
        self.plant({})
        self.assertEqual(delegation.live_sessions(self.home), {})

    def test_no_store_means_no_children(self) -> None:
        self.assertEqual(delegation.children(self.home / "missing", "s", set()), [])


if __name__ == "__main__":
    unittest.main()
