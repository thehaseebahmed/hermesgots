"""A run held on a prompt is the user's move, not work in progress.

Hermes projects what a run is held on (an approval, a question) on ``GET /v1/runs/{id}``, and that
is the only one account of it: a question never lands on the run's status at all, and an approval
lands there only on the path that runs the agent in process — a canonical ``/v1/runs`` turn holds its
prompt in the admission's own controls and never touches the status. So a session waiting on either
read as ``running`` in ``runs/live``, and every screen grouping the run maps put it under Working
while the chat drew the very prompt it was waiting on (ADR 0053).

``sessions.prompts`` asks that projection per run the poll already knows, ``sessions.held_runs``
marks those runs as the wait they are, and ``sessions.waiting`` carries the reason for the row.

Run: python3 -m unittest plugin.tests.test_clarify_wait -v
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from typing import Any, Dict, Optional
from unittest import mock

from plugin import sessions
from plugin.tests._helpers import temp_hermes_home

MISSING = Path("/nonexistent-state-and-store")
QUESTION = {"kind": "clarify", "prompt_id": "p1", "execution_generation": 0, "question": "Which?"}
APPROVAL = {"kind": "approval", "prompt_id": "p2", "execution_generation": 0, "command": "rm -rf build\n"}


class Projection:
    """Hermes's ``gateway.platforms.api_server_authority_runs``: what each run is holding."""

    def __init__(self, holds: Optional[Dict[str, Any]] = None, *, raises: bool = False) -> None:
        self.holds = holds if holds is not None else {}
        self.raises = raises
        self.asked: list = []

    def run_projection(self, adapter: Any, run_id: str) -> Optional[Dict[str, Any]]:
        self.asked.append(run_id)
        if self.raises:
            raise RuntimeError("the admission store is busy")
        controls = self.holds.get(run_id)
        return None if controls is None else {"run_id": run_id, "pending_controls": list(controls)}


class HeldTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)

    def projection(self, holds: Optional[Dict[str, Any]] = None, *, raises: bool = False) -> Projection:
        """Hermes's module, patched in for the deferred import ``sessions.prompts`` makes."""
        stub = Projection(holds, raises=raises)
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        module = types.ModuleType("gateway.platforms.api_server_authority_runs")
        module.run_projection = stub.run_projection  # type: ignore[attr-defined]
        gateway.platforms = platforms  # type: ignore[attr-defined]
        platforms.api_server_authority_runs = module  # type: ignore[attr-defined]
        patcher = mock.patch.dict(
            sys.modules,
            {
                "gateway": gateway,
                "gateway.platforms": platforms,
                "gateway.platforms.api_server_authority_runs": module,
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        return stub

    def test_a_held_question_reads_as_the_wait_it_is(self) -> None:
        stub = self.projection({"run-1": [QUESTION]})
        live, run_ids = {"s_1": "running"}, {"s_1": "run-1"}

        asked = sessions.prompts(None, run_ids)
        self.assertEqual(stub.asked, ["run-1"], "the run this poll already knows, and nothing else")
        self.assertEqual(asked, {"s_1": {"kind": "question", "count": 1}})
        self.assertEqual(
            sessions.held_runs(live, asked), {"s_1": "waiting_for_approval"}, "the wait the app groups by"
        )
        self.assertEqual(
            sessions.waiting(None, MISSING, self.home, asked=asked),
            {"s_1": {"kind": "question", "count": 1}},
        )

    def test_a_held_approval_reads_as_a_wait_with_its_command(self) -> None:
        self.projection({"run-1": [APPROVAL]})
        asked = sessions.prompts(None, {"s_1": "run-1"})
        self.assertEqual(asked, {"s_1": {"kind": "approval", "command": "rm -rf build"}})
        self.assertEqual(sessions.held_runs({"s_1": "running"}, asked), {"s_1": "waiting_for_approval"})

    def test_every_question_the_run_holds_is_counted(self) -> None:
        self.projection({"run-1": [QUESTION, {**QUESTION, "prompt_id": "p2"}]})
        self.assertEqual(
            sessions.prompts(None, {"s_1": "run-1"}), {"s_1": {"kind": "question", "count": 2}}
        )

    def test_a_run_holding_nothing_is_no_hold(self) -> None:
        self.projection({"run-1": []})
        self.assertEqual(sessions.prompts(None, {"s_1": "run-1"}), {})
        self.assertEqual(
            sessions.held_runs({"s_1": "running"}, {}), {"s_1": "running"}, "the run carries on, at work"
        )

    def test_a_run_with_no_admission_is_no_hold(self) -> None:
        self.projection({})
        self.assertEqual(sessions.prompts(None, {"s_1": "run-1"}), {}, "no projection, nothing held")

    def test_a_projection_that_fails_leaves_the_run_maps_as_they_were(self) -> None:
        self.projection(raises=True)
        self.assertEqual(sessions.prompts(None, {"s_1": "run-1"}), {})

    def test_a_host_without_the_projection_keeps_the_run_maps_as_they_were(self) -> None:
        with mock.patch.dict(sys.modules, {"gateway.platforms.api_server_authority_runs": None}):
            self.assertEqual(sessions.prompts(None, {"s_1": "run-1"}), {})

    def test_a_session_with_no_run_asks_nothing(self) -> None:
        stub = self.projection({"run-1": [QUESTION]})
        self.assertEqual(sessions.prompts(None, {"s_1": ""}), {})
        self.assertEqual(stub.asked, [])

    def test_a_run_already_waiting_keeps_the_state_it_had(self) -> None:
        live = {"s_1": "waiting_for_approval", "s_2": "running"}
        self.assertEqual(
            sessions.held_runs(live, {"s_1": {"kind": "question"}}),
            {"s_1": "waiting_for_approval", "s_2": "running"},
        )
