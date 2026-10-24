"""Stopping a turn stops the subagents that turn started.

Core detaches a delegated child before it dispatches it, so a run's own stop — the app's
``POST /v1/runs/{id}/stop`` — never reaches the children that run began: the API server's stop
handler interrupts the run's agent and reaps its processes, and nothing else. So the plugin's watch
hands a stopped run's stop to its session's subagents itself, on the session's own stop.
These tests pin that fan-out from outside: which children a stopped run names, which it leaves
alone, and what the watch does with a host that can stop nothing.

Run: python3 -m unittest plugin.tests.test_delegation_stop -v
"""

from __future__ import annotations

import asyncio
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, List
from unittest import mock

from plugin import delegation


class Adapter:
    """The API server adapter, as far as the watch reads it: the run statuses it keeps."""

    def __init__(self) -> None:
        self._run_statuses: Dict[str, Dict[str, Any]] = {}

    def run(self, run_id: str, status: str, session_id: str, created_at: float | None = None) -> None:
        self._run_statuses[run_id] = {"run_id": run_id, "status": status, "session_id": session_id}
        if created_at is not None:
            self._run_statuses[run_id]["created_at"] = created_at


class Interrupts:
    """Core's ``interrupt_for_session``: what it was asked to stop, and how many it claimed."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.count = 1

    def __call__(
        self,
        session_key: str = "",
        origin_ui_session_id: str = "",
        parent_session_id: str = "",
        reason: str = "session_end",
    ) -> int:
        self.calls.append(
            {
                "session_key": session_key,
                "origin_ui_session_id": origin_ui_session_id,
                "parent_session_id": parent_session_id,
                "reason": reason,
            }
        )
        return self.count


class StopTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(self.conn.close)
        self.conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, model_config TEXT, parent_session_id TEXT,"
            " started_at REAL, ended_at REAL, end_reason TEXT, tool_call_count INTEGER DEFAULT 0)"
        )
        self.conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT)")
        self.clock = 0.0

        # Hermes's own stop of a session's background delegations, planted the way the suite's
        # harness trap says: this machine has no ``tools`` package.
        self.interrupt = Interrupts()
        self.plant(self.interrupt)
        self.adapter = Adapter()

    def plant(self, interrupt: Any) -> None:
        async_delegation = ModuleType("tools.async_delegation")
        setattr(async_delegation, "interrupt_for_session", interrupt)
        tools = ModuleType("tools")
        setattr(tools, "async_delegation", async_delegation)
        patching = mock.patch.dict(
            sys.modules, {"tools": tools, "tools.async_delegation": async_delegation}
        )
        patching.start()
        self.addCleanup(patching.stop)

    def session(
        self,
        sid: str,
        parent: str | None = None,
        *,
        delegate_from: str | None = None,
        ended: bool = False,
        reason: str | None = None,
        goal: str | None = None,
    ) -> None:
        self.clock += 1
        config = '{"_delegate_from": "%s"}' % delegate_from if delegate_from else None
        self.conn.execute(
            "INSERT INTO sessions VALUES (?, 'm', ?, ?, ?, ?, ?, 0)",
            (sid, config, parent, self.clock, self.clock if ended else None, reason),
        )
        if goal:
            self.conn.execute("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)", (sid, goal))
        # Every insert committed: an uncommitted row is invisible to the code's own connection.
        self.conn.commit()

    def test_a_stopped_run_stops_its_live_subagents(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s", goal="plan the auth refactor")
        self.session("c2", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")
        named = delegation.sweep(self.adapter, [self.home])
        self.assertEqual(named, ["c1", "c2"])
        self.assertEqual(
            self.interrupt.calls,
            [
                {
                    "session_key": "",
                    "origin_ui_session_id": "",
                    "parent_session_id": "s",
                    "reason": "run_stop",
                }
            ],
        )

    def test_a_child_that_ended_is_left_alone(self) -> None:
        self.session("s")
        self.session("done", "s", delegate_from="s", ended=True, reason="agent_close")
        self.session("stopped", "s", delegate_from="s", ended=True, reason="interrupted")
        self.session("open", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), ["open"])

    def test_another_session_s_children_are_left_alone(self) -> None:
        self.session("s")
        self.session("other")
        self.session("c1", "s", delegate_from="s")
        self.session("c2", "other", delegate_from="other")
        self.adapter.run("run-1", "cancelled", "s")
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), ["c1"])

    def test_every_live_child_of_the_run_is_stopped(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.session("c2", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s", created_at=1.5)
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), ["c1", "c2"])

    def test_a_child_of_an_earlier_turn_is_left_alone(self) -> None:
        # A turn that ended leaves its subagents working, and each is stopped from its own card
        # (ADR 0038): a later turn's stop is not theirs to take.
        self.session("s")
        self.session("earlier", "s", delegate_from="s")
        self.session("this-run", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s", created_at=self.clock - 0.5)
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), ["this-run"])
        self.assertEqual(self.interrupt.calls[0]["parent_session_id"], "s")

    def test_a_stop_with_no_child_of_its_own_touches_nobody(self) -> None:
        # Nothing was delegated by the run being stopped, so nothing is interrupted: the session
        # still has a child from an earlier turn, and stopping it is that child's card's business.
        self.session("s")
        self.session("earlier", "s", delegate_from="s")
        self.adapter.run("run-1", "cancelled", "s", created_at=self.clock + 5)
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), [])
        self.assertEqual(self.interrupt.calls, [])

    def test_a_child_of_the_compressed_tip_is_stopped_too(self) -> None:
        self.session("s", ended=True, reason="compression")
        self.session("tip", "s")
        self.session("c1", "tip", delegate_from="tip")
        self.adapter.run("run-1", "stopping", "s")
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), ["c1"])
        # A delegation made after the compression came from the tip, so that is the session core
        # has the record under.
        self.assertEqual(
            [c["parent_session_id"] for c in self.interrupt.calls], ["s", "tip"]
        )

    def test_a_turn_that_is_still_running_stops_nobody(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "running", "s")
        self.adapter.run("run-2", "waiting_for_approval", "s")
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), [])
        self.assertEqual(self.interrupt.calls, [])

    def test_a_turn_that_completed_or_failed_stops_nobody(self) -> None:
        # The whole point of a delegation running beside its turn: a turn that ends leaves its
        # subagents working, and each is stopped from its own card, not by its turn.
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "completed", "s")
        self.adapter.run("run-2", "failed", "s")
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), [])
        self.assertEqual(self.interrupt.calls, [])

    def test_a_run_with_no_session_stops_nobody(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter._run_statuses["run-1"] = {"run_id": "run-1", "status": "stopping"}
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), [])
        self.assertEqual(self.interrupt.calls, [])

    def test_a_stop_is_handed_over_once(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")
        handed: Dict[str, None] = {}
        self.assertEqual(delegation.sweep(self.adapter, [self.home], handed), ["c1"])
        # The status lingers while the run unwinds, and the child's row stays open until core
        # finalizes it: the watch must not interrupt the same run again.
        self.adapter.run("run-1", "cancelled", "s")
        self.assertEqual(delegation.sweep(self.adapter, [self.home], handed), [])
        self.assertEqual(len(self.interrupt.calls), 1)

    def test_two_stopped_turns_are_each_handed_over(self) -> None:
        self.session("s1")
        self.session("s2")
        self.session("c1", "s1", delegate_from="s1")
        self.session("c2", "s2", delegate_from="s2")
        self.adapter.run("run-1", "stopping", "s1")
        self.adapter.run("run-2", "cancelled", "s2")
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), ["c1", "c2"])
        self.assertEqual(
            [c["parent_session_id"] for c in self.interrupt.calls], ["s1", "s2"]
        )

    def test_a_stop_core_cannot_find_is_survived(self) -> None:
        # The records live in the gateway's memory, so a restart loses them: a stop that reaches
        # nothing is a debug line, not an error — and not something to try again every second.
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")
        self.interrupt.count = 0
        handed: Dict[str, None] = {}
        self.assertEqual(delegation.sweep(self.adapter, [self.home], handed), ["c1"])
        self.assertEqual(delegation.sweep(self.adapter, [self.home], handed), [])
        self.assertEqual(len(self.interrupt.calls), 1)

    def test_a_core_that_refuses_the_stop_is_survived(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")

        def broken(**kwargs: Any) -> int:
            raise RuntimeError("tools.async_delegation moved")

        self.plant(broken)
        self.assertEqual(delegation.sweep(self.adapter, [self.home]), ["c1"])

    def test_the_watch_hands_a_stop_over_and_waits_a_tick(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")
        constants = ModuleType("hermes_constants")
        setattr(constants, "get_hermes_home", lambda: str(self.home))

        def one_tick(_seconds: float) -> None:
            raise RuntimeError("one tick is enough")

        with mock.patch.dict(sys.modules, {"hermes_constants": constants}), mock.patch.object(
            delegation.asyncio, "sleep", side_effect=one_tick
        ) as sleep:
            with self.assertRaises(RuntimeError):
                asyncio.run(delegation.run(self.adapter))
        sleep.assert_called_once_with(delegation.STOP_SECONDS)
        self.assertEqual([c["parent_session_id"] for c in self.interrupt.calls], ["s"])


if __name__ == "__main__":
    unittest.main()
