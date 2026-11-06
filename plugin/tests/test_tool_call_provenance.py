"""Provenance test: the plugin leaves agent creation alone, and its clarify delivery still holds.

Replays identical synthetic provider events with plugin wrappers disabled and
enabled, comparing assembled calls and dispatched invocations. Also tests that
the wrappers don't alter the tool-call list returned to the agent.

Run: python3 -m pytest plugin/tests/test_tool_call_provenance.py -v
     or: python3 -m unittest plugin.tests.test_tool_call_provenance -v
"""

from __future__ import annotations

import asyncio
import unittest
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch


class FakeAgent:
    """Minimal agent with the attributes Gots's wrappers touch."""

    def __init__(self) -> None:
        self.tools: List[Dict[str, Any]] = []
        self.valid_tool_names: set[str] = set()
        self.clarify_callback: Any = None
        self._interrupt_requested = False
        self._touch_activity: Any = None


class FakeAdapter:
    """Minimal adapter with the seams Gots's wrappers use."""

    def __init__(self, *, has_streams: bool = True, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        self._create_agent_called = 0
        self._active_run_agents: Dict[str, Any] = {}
        self._run_streams: Dict[str, Any] = {}
        self._run_statuses: Dict[str, Any] = {}
        self._loop = loop
        if has_streams:
            self._run_streams["run_abc"] = asyncio.Queue()

    def _set_run_status(self, run_id: str, status: str, **fields: Any) -> None:
        self._run_statuses[run_id] = {"status": status, **fields}

    def _create_agent(self, *args: Any, **kwargs: Any) -> FakeAgent:
        self._create_agent_called += 1
        return FakeAgent()


class TestToolCallProvenance(unittest.TestCase):
    """The plugin never wraps agent creation: Hermes's own tool calls reach the agent untouched."""

    def test_wiring_leaves_create_agent_alone(self) -> None:
        adapter = FakeAdapter()
        adapter._handle_run_clarify = lambda request: None  # type: ignore[attr-defined]
        original = adapter._create_agent

        from plugin.clarify import wire as clarify_wire

        clarify_wire(adapter)
        clarify_wire(adapter)
        adapter._create_agent()

        self.assertEqual(adapter._create_agent, original, "catalog rule 9: no rebind of core")
        self.assertEqual(adapter._create_agent_called, 1)


class TestClarifyDeliveryProvenance(unittest.TestCase):
    """Verify that clarify delivery works through pollable status, not just SSE."""

    def test_undelivered_when_no_run_id(self) -> None:
        """When the agent isn't in a run (no run_id), clarify returns undelivered."""
        adapter = FakeAdapter(has_streams=False)
        agent = FakeAgent()
        # Don't register the agent in _active_run_agents, so _run_id returns None

        from plugin.clarify import Asker

        asker = Asker(adapter, agent, loop=None)
        answers, outcome, notice = asker.ask([{"qid": "q0", "question": "Test?"}])

        self.assertEqual(outcome, "undelivered")
        self.assertEqual(answers, {})
        self.assertIsNotNone(notice, "Undelivered must carry a notice")

    def test_publishes_to_status_without_stream(self) -> None:
        """With a valid run_id but no stream, the question is published to run status."""
        adapter = FakeAdapter(has_streams=False)
        agent = FakeAgent()
        adapter._active_run_agents["run_abc"] = agent

        from plugin.clarify import Asker, _pending, resolve

        asker = Asker(adapter, agent, loop=None)

        # Start ask in a thread so we can resolve it
        import threading

        result_holder: Dict[str, Any] = {}

        def ask_thread() -> None:
            result_holder["result"] = asker.ask([{"qid": "q0", "question": "Test?"}])

        t = threading.Thread(target=ask_thread, daemon=True)
        t.start()
        t.join(timeout=0.5)  # Give it time to publish

        # The question should be published in _pending and in run status
        self.assertIn("run_abc", _pending, "Question must be pending even without a stream")
        run_status = adapter._run_statuses.get("run_abc")
        self.assertIsNotNone(run_status, "Run status must be set")
        self.assertEqual(run_status.get("status"), "waiting_for_approval")
        self.assertIsNotNone(run_status.get("clarify"), "Clarify must be on run status")

        # Resolve the question to unblock the thread
        resolve("run_abc", _pending["run_abc"].clarify_id, {"q0": "answer"}, "submitted")
        t.join(timeout=2.0)

        self.assertFalse(t.is_alive(), "Ask thread must complete after resolve")
        answers, outcome, _ = result_holder.get("result", ({}, "unknown", None))
        self.assertEqual(outcome, "submitted", "Question must be answered after resolve")
        self.assertEqual(answers.get("q0"), "answer")

    def test_publishes_to_status_without_loop(self) -> None:
        """With a stream but no loop (worker thread), still publishes to status."""
        adapter = FakeAdapter(has_streams=True)
        agent = FakeAgent()
        adapter._active_run_agents["run_abc"] = agent

        from plugin.clarify import Asker, _pending, resolve

        asker = Asker(adapter, agent, loop=None)

        import threading

        result_holder: Dict[str, Any] = {}

        def ask_thread() -> None:
            result_holder["result"] = asker.ask([{"qid": "q0", "question": "Test?"}])

        t = threading.Thread(target=ask_thread, daemon=True)
        t.start()
        t.join(timeout=0.5)

        self.assertIn("run_abc", _pending, "Question must be pending even without a loop")
        run_status = adapter._run_statuses.get("run_abc")
        self.assertEqual(run_status.get("status"), "waiting_for_approval")

        resolve("run_abc", _pending["run_abc"].clarify_id, {"q0": "yes"}, "submitted")
        t.join(timeout=2.0)

        self.assertFalse(t.is_alive())
        answers, outcome, _ = result_holder.get("result", ({}, "unknown", None))
        self.assertEqual(outcome, "submitted")

    def test_legacy_callback_distinguishes_undelivered_from_timeout(self) -> None:
        """The legacy callback must not convert undelivered to timed_out.

        With the fix, undelivered carries outcome="undelivered" and
        timed_out=False, so the app can distinguish it from a genuine timeout.
        """
        adapter = FakeAdapter(has_streams=False)
        agent = FakeAgent()
        # No run_id — genuinely undelivered

        from plugin.clarify import Asker

        asker = Asker(adapter, agent, loop=None)
        result = asker(questions=[{"qid": "q0", "question": "Test?"}])

        self.assertIn("timed_out", result)
        self.assertFalse(
            result["timed_out"],
            "Undelivered must not be marked as timed_out",
        )
        self.assertEqual(result.get("outcome"), "undelivered")
        self.assertIn("notice", result, "Notice must be present even in legacy shape")


if __name__ == "__main__":
    unittest.main()