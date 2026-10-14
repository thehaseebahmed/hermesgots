"""An approval that ends without an answer through Hermes's route tells the run's clients.

Run: python3 -m unittest plugin.tests.test_approvals -v
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest import mock

from plugin import approvals


class _Loop:
    def call_soon_threadsafe(self, fn, *args):
        fn(*args)


class _Stream:
    def __init__(self) -> None:
        self.events = []

    def put_nowait(self, event) -> None:
        self.events.append(event)


class _Adapter:
    def __init__(self, status: dict) -> None:
        self._run_statuses = {"run_1": status}
        self._run_streams = {"run_1": _Stream()}

    def _set_run_status(self, run_id: str, status: str, **fields) -> None:
        current = self._run_statuses[run_id]
        current.update({"status": status, **fields})
        if status != approvals.WAITING:
            current.pop("approval", None)


def _waiting() -> dict:
    return {"status": "waiting_for_approval", "session_id": "s_1", "approval": {"command": "rm -rf logs"}}


class ApprovalsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = _Adapter(_waiting())
        self.queue: list = []
        fake = types.ModuleType("tools.approval")
        fake.list_gateway_approvals = lambda key: list(self.queue)  # type: ignore[attr-defined]
        tools = types.ModuleType("tools")
        tools.approval = fake  # type: ignore[attr-defined]
        for patcher in (
            mock.patch.dict(sys.modules, {"tools": tools, "tools.approval": fake}),
            mock.patch.object(approvals, "adapter", self.adapter),
            mock.patch.object(approvals, "loop", _Loop()),
            mock.patch.object(approvals.events, "note"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _sent(self):
        return self.adapter._run_streams["run_1"].events

    def test_timeout_resets_the_status_and_tells_the_stream(self) -> None:
        approvals.settled(session_key="run_1", choice="timeout")
        status = self.adapter._run_statuses["run_1"]
        self.assertEqual(status["status"], "running")
        self.assertNotIn("approval", status)
        self.assertEqual([(e["event"], e["choice"]) for e in self._sent()], [("approval.responded", "timeout")])

    def test_a_clients_answer_is_left_to_hermes(self) -> None:
        approvals.settled(session_key="run_1", choice="once")
        self.assertEqual(self.adapter._run_statuses["run_1"]["status"], "waiting_for_approval")
        self.assertEqual(self._sent(), [])

    def test_another_request_still_waiting_keeps_the_status(self) -> None:
        self.queue.append(object())
        approvals.settled(session_key="run_1", choice="cancelled")
        self.assertEqual(self.adapter._run_statuses["run_1"]["status"], "waiting_for_approval")
        self.assertEqual(self._sent(), [])

    def test_a_run_no_longer_waiting_is_left_alone(self) -> None:
        self.adapter._run_statuses["run_1"] = {"status": "completed"}
        approvals.settled(session_key="run_1", choice="timeout")
        self.assertEqual(self.adapter._run_statuses["run_1"]["status"], "completed")
        self.assertEqual(self._sent(), [])

    def test_auto_announces_its_own_answer(self) -> None:
        self.assertTrue(approvals.announce("run_1", "once"))
        self.assertEqual(self._sent()[0]["choice"], "once")


if __name__ == "__main__":
    unittest.main()
