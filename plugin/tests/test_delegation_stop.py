"""Stopping a turn stops the subagents that turn started, and only those.

Core detaches a delegated child before it dispatches it, so a run's own stop — the app's
``POST /v1/runs/{id}/stop`` — never reaches the children that run began: the API server's stop
handler interrupts the run's agent and reaps its processes, and nothing else. So the plugin's watch
hands a stopped run's stop to the children that run started, one at a time, through the same
per-child call a card's Stop makes.

These tests pin that from outside, against a fake of core's own selectors: core's delegation records
are selected by a session and nothing finer (``tools.async_delegation._session_records``,
``:738-750``), so its ``interrupt_for_session`` stops every live child of the session; its
``delegate_tool_registry.interrupt_subagent`` (``:92-105``) stops one child, by core's ``sa-…`` id.
Which children a stopped run names, which it leaves alone, and — the point — that a child the run
didn't start survives with its card still running.

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


class Live:
    """The live child agent core's registry holds: the child's own session id, and nothing else
    this code reads."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id


class Core:
    """Core's stop machinery, with the selectors it really has.

    ``tools.async_delegation``'s records are one per delegation *unit*, not one per child, and
    ``_session_records`` selects them by a session alone — ``session_key``, ``origin_ui_session_id``
    or ``parent_session_id`` — so ``interrupt_for_session`` stops every live child of that session, an
    earlier turn's included. ``interrupt_subagent`` takes one child, by core's own ``sa-…`` id. Both
    are modelled here, so a plugin that reached for the session-wide call would interrupt the earlier
    child for real and fail the test that says it must not.

    A stopped child leaves the live registry, as it does when the child reaches its next iteration
    boundary — which is what makes its card read stopped while another's still reads running.
    """

    def __init__(self) -> None:
        # The child session ids stopped, in order, and the parents a session-wide stop asked for.
        self.stopped: List[str] = []
        self.wide: List[str] = []
        # Core's registry of live children: core's ``sa-…`` id -> the record it keeps.
        self._active_subagents: Dict[str, Any] = {}
        # A host whose child had already ended when the stop landed.
        self.declines = False

    def start(self, agent_id: str, child: str, parent: str) -> None:
        self._active_subagents[agent_id] = {
            "agent": Live(child),
            "owner_agent_session_id": parent,
        }

    def interrupt_subagent(self, agent_id: str) -> bool:
        if self.declines:
            return False
        record = self._active_subagents.get(agent_id)
        if record is None:
            return False
        child = record["agent"].session_id
        self.stopped.append(child)
        self._active_subagents.pop(agent_id, None)
        return True

    def interrupt_for_session(
        self,
        session_key: str = "",
        origin_ui_session_id: str = "",
        parent_session_id: str = "",
        reason: str = "session_end",
    ) -> int:
        """Every live child of one session, whichever turn started it (``_session_records``)."""
        parent = parent_session_id or session_key or origin_ui_session_id
        self.wide.append(parent)
        mine = [
            agent_id
            for agent_id, record in list(self._active_subagents.items())
            if record["owner_agent_session_id"] == parent
        ]
        return sum(1 for agent_id in mine if self.interrupt_subagent(agent_id))

    def running(self) -> List[str]:
        return [record["agent"].session_id for record in self._active_subagents.values()]


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

        self.core = Core()
        self.plant()
        self.adapter = Adapter()

    def plant(self) -> None:
        """Core's two modules, planted the way the suite's harness trap says: this machine has no
        ``tools`` package, and the plugin imports both lazily."""
        registry = ModuleType("tools.delegate_tool_registry")
        registry.interrupt_subagent = self.core.interrupt_subagent
        registry._active_subagents = self.core._active_subagents
        async_delegation = ModuleType("tools.async_delegation")
        async_delegation.interrupt_for_session = self.core.interrupt_for_session
        tools = ModuleType("tools")
        tools.delegate_tool_registry = registry
        tools.async_delegation = async_delegation
        patching = mock.patch.dict(
            sys.modules,
            {
                "tools": tools,
                "tools.delegate_tool_registry": registry,
                "tools.async_delegation": async_delegation,
            },
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
        # An open delegated child is a child core still runs, so its registry record is the pair a
        # ``subagent_start`` hook keeps: core's own id, and the session it writes under.
        if delegate_from and not ended:
            self.core.start(f"sa-{sid}", sid, parent or delegate_from)

    def card(self, session_id: str) -> Dict[str, str]:
        """What the app's cards read for a session: each child's id, as its card holds it, and state."""
        return {child["id"]: child["status"] for child in delegation.children(self.home, session_id, set())}

    def test_a_stopped_run_stops_its_live_subagents(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s", goal="plan the auth refactor")
        self.session("c2", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")
        named = delegation.sweep_stops(self.adapter, [self.home])
        self.assertEqual(named, ["c1", "c2"])
        self.assertEqual(self.core.stopped, ["c1", "c2"], "each child core holds was stopped")
        self.assertEqual(self.core.wide, [], "no session-wide stop: that reaches other turns' children")

    def test_a_child_that_ended_is_left_alone(self) -> None:
        self.session("s")
        self.session("done", "s", delegate_from="s", ended=True, reason="agent_close")
        self.session("stopped", "s", delegate_from="s", ended=True, reason="interrupted")
        self.session("open", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), ["open"])
        self.assertEqual(self.core.stopped, ["open"])

    def test_another_session_s_children_are_left_alone(self) -> None:
        self.session("s")
        self.session("other")
        self.session("c1", "s", delegate_from="s")
        self.session("c2", "other", delegate_from="other")
        self.adapter.run("run-1", "cancelled", "s")
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), ["c1"])
        self.assertEqual(self.core.stopped, ["c1"], "the other session's child still runs")
        self.assertEqual(self.core.running(), ["c2"])

    def test_every_live_child_of_the_run_is_stopped(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.session("c2", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s", created_at=1.5)
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), ["c1", "c2"])
        self.assertEqual(self.core.stopped, ["c1", "c2"])

    def test_a_child_of_an_earlier_turn_survives_the_stop(self) -> None:
        # A turn that ended leaves its subagents working, and each is stopped from its own card
        # (ADR 0038): a later turn's stop is not theirs to take. Core's session-wide stop has no
        # selector finer than the session, so it would take this one too — which is why the fan-out
        # stops the run's named children one at a time instead.
        self.session("s")
        self.session("earlier", "s", delegate_from="s")
        self.session("this-run", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s", created_at=self.clock - 0.5)
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), ["this-run"])
        self.assertEqual(self.core.stopped, ["this-run"], "the run's own child was stopped")
        self.assertEqual(self.core.wide, [], "and no session-wide stop was asked for at all")
        # The proof the filter is real: had the session-wide call been made, the fake would have
        # cascaded to the earlier child, and its card would read stopped beside this run's.
        self.assertEqual(self.card("s"), {"earlier": "running", "this-run": "stopped"})

    def test_a_stop_with_no_child_of_its_own_touches_nobody(self) -> None:
        # Nothing was delegated by the run being stopped, so nothing is interrupted: the session
        # still has a child from an earlier turn, and stopping it is that child's card's business.
        self.session("s")
        self.session("earlier", "s", delegate_from="s")
        self.adapter.run("run-1", "cancelled", "s", created_at=self.clock + 5)
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), [])
        self.assertEqual(self.core.stopped, [])
        self.assertEqual(self.core.running(), ["earlier"])

    def test_a_child_of_the_compressed_tip_is_stopped_too(self) -> None:
        self.session("s", ended=True, reason="compression")
        self.session("tip", "s")
        self.session("c1", "tip", delegate_from="tip")
        self.adapter.run("run-1", "stopping", "s")
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), ["c1"])
        # A delegation made after the compression came from the tip, and its card holds the child's
        # id whichever session started it: one stop, by that id, and no walk of the lineage.
        self.assertEqual(self.core.stopped, ["c1"])

    def test_a_turn_that_is_still_running_stops_nobody(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "running", "s")
        self.adapter.run("run-2", "waiting_for_approval", "s")
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), [])
        self.assertEqual(self.core.stopped, [])

    def test_a_turn_that_completed_or_failed_stops_nobody(self) -> None:
        # The whole point of a delegation running beside its turn: a turn that ends leaves its
        # subagents working, and each is stopped from its own card, not by its turn.
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "completed", "s")
        self.adapter.run("run-2", "failed", "s")
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), [])
        self.assertEqual(self.core.stopped, [])

    def test_a_run_with_no_session_stops_nobody(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter._run_statuses["run-1"] = {"run_id": "run-1", "status": "stopping"}
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), [])
        self.assertEqual(self.core.stopped, [])

    def test_a_stop_is_handed_over_once(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")
        handed: Dict[str, None] = {}
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home], handed), ["c1"])
        # The status lingers while the run unwinds, and the child's row stays open until core
        # finalizes it: the watch must not stop the same run again.
        self.adapter.run("run-1", "cancelled", "s")
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home], handed), [])
        self.assertEqual(self.core.stopped, ["c1"])

    def test_two_stopped_turns_are_each_handed_over(self) -> None:
        self.session("s1")
        self.session("s2")
        self.session("c1", "s1", delegate_from="s1")
        self.session("c2", "s2", delegate_from="s2")
        self.adapter.run("run-1", "stopping", "s1")
        self.adapter.run("run-2", "cancelled", "s2")
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), ["c1", "c2"])
        self.assertEqual(self.core.stopped, ["c1", "c2"])

    def test_a_stop_core_declines_is_survived(self) -> None:
        # The records live in the gateway's memory, so a restart loses them: a stop that reaches
        # nothing is a debug line, not an error — and not something to try again every second.
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.core.declines = True
        self.adapter.run("run-1", "stopping", "s")
        handed: Dict[str, None] = {}
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home], handed), ["c1"])
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home], handed), [])
        self.assertEqual(self.core.stopped, [])
        self.assertEqual(self.core.wide, [])

    def test_a_child_core_has_no_record_of_is_named_and_left(self) -> None:
        # A child some other process dispatched is not in this process's registry, which is all a
        # stop can reach: it is named as the run's, and nothing can be stopped.
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.core._active_subagents.clear()
        self.adapter.run("run-1", "stopping", "s")
        self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), ["c1"])
        self.assertEqual(self.core.stopped, [])
        self.assertEqual(self.core.wide, [], "the session-wide call was the wrong tool, not a fallback")

    def test_a_core_that_refuses_the_stop_is_survived(self) -> None:
        self.session("s")
        self.session("c1", "s", delegate_from="s")
        self.adapter.run("run-1", "stopping", "s")

        def broken(agent_id: str) -> bool:
            raise RuntimeError("tools.delegate_tool_registry moved")

        registry = sys.modules["tools.delegate_tool_registry"]
        with mock.patch.object(registry, "interrupt_subagent", side_effect=broken):
            self.assertEqual(delegation.sweep_stops(self.adapter, [self.home]), ["c1"])

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
                asyncio.run(delegation.watch_stops(self.adapter))
        sleep.assert_called_once_with(delegation.STOP_SECONDS)
        self.assertEqual(self.core.stopped, ["c1"])


if __name__ == "__main__":
    unittest.main()
