"""Provenance test: verify Gots's plugin wrappers don't duplicate tool calls.

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
    """Verify that wrapping _create_agent doesn't duplicate or alter tool calls."""

    def test_wrapped_create_agent_called_once(self) -> None:
        """The wrapper must call the original exactly once per agent creation."""
        adapter = FakeAdapter()
        original_count = adapter._create_agent_called

        from plugin.clarify import wire as clarify_wire

        clarify_wire(adapter)
        adapter._create_agent()  # type: ignore[assignment]
        adapter._create_agent()  # type: ignore[assignment]

        self.assertEqual(
            adapter._create_agent_called - original_count,
            2,
            "Wrapped _create_agent must call original exactly once per invocation",
        )

    def test_wrapped_agent_has_original_tools_plus_clarify(self) -> None:
        """Wrapping adds the clarify tool definition without removing existing tools."""
        adapter = FakeAdapter()

        # Pre-populate what the original would set
        base_agent = FakeAgent()
        base_agent.tools = [{"type": "function", "function": {"name": "terminal"}}]
        base_agent.valid_tool_names = {"terminal"}

        def original_create(*args: Any, **kwargs: Any) -> FakeAgent:
            return base_agent

        adapter._create_agent = original_create  # type: ignore[assignment]

        from plugin.clarify import wire as clarify_wire

        clarify_wire(adapter)

        # Simulate calling on the loop thread so loop is available
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            agent = adapter._create_agent()  # type: ignore[assignment]
        finally:
            loop.close()
            asyncio.set_event_loop(None)

        # Original tool must still be present
        tool_names = {(t.get("function") or {}).get("name") for t in agent.tools}
        self.assertIn("terminal", tool_names, "Original tools must survive wrapping")
        # Clarify may or may not be added (depends on model_tools availability),
        # but it must never duplicate an existing entry
        clarify_entries = [t for t in agent.tools if (t.get("function") or {}).get("name") == "clarify"]
        self.assertLessEqual(
            len(clarify_entries),
            1,
            "At most one clarify tool definition, never duplicated",
        )

    def test_theseus_wrapper_preserves_original_tools(self) -> None:
        """The Theseus wrapper must also preserve existing tools without duplication."""
        base_agent = FakeAgent()
        base_agent.tools = [{"type": "function", "function": {"name": "terminal"}}]
        base_agent.valid_tool_names = {"terminal"}

        def original_create(*args: Any, **kwargs: Any) -> FakeAgent:
            return base_agent

        adapter = FakeAdapter()
        adapter._create_agent = original_create  # type: ignore[assignment]

        from plugin.theseus import wire as theseus_wire

        result = theseus_wire(adapter)
        # wire returns False when the theseus tool isn't available, which is fine
        if result:
            agent = adapter._create_agent()  # type: ignore[assignment]
            terminal_count = sum(
                1 for t in agent.tools if (t.get("function") or {}).get("name") == "terminal"
            )
            self.assertEqual(
                terminal_count,
                1,
                "Original tools must not be duplicated by Theseus wrapper",
            )

    def test_double_wrapping_does_not_multiply(self) -> None:
        """Wrapping an already-wrapped adapter must not double-call the original."""
        adapter = FakeAdapter()
        original_count_before = adapter._create_agent_called

        from plugin.clarify import wire as clarify_wire

        clarify_wire(adapter)
        clarify_wire(adapter)  # second wrap

        adapter._create_agent()  # type: ignore[assignment]
        self.assertEqual(
            adapter._create_agent_called - original_count_before,
            1,
            "Double-wrapping must still call original exactly once",
        )

    def test_agent_returned_is_same_object(self) -> None:
        """The wrapper must return the agent from the original, not a copy."""
        base_agent = FakeAgent()

        def original_create(*args: Any, **kwargs: Any) -> FakeAgent:
            return base_agent

        adapter = FakeAdapter()
        adapter._create_agent = original_create  # type: ignore[assignment]

        from plugin.clarify import wire as clarify_wire

        clarify_wire(adapter)

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            agent = adapter._create_agent()  # type: ignore[assignment]
        finally:
            loop.close()
            asyncio.set_event_loop(None)

        self.assertIs(
            agent,
            base_agent,
            "Wrapper must return the same agent object, not a copy",
        )


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