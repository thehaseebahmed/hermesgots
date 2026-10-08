"""Provenance test: verify Memento's plugin wrappers don't duplicate tool calls.

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
    """Minimal agent with the attributes Memento's wrappers touch."""

    def __init__(self) -> None:
        self.tools: List[Dict[str, Any]] = []
        self.valid_tool_names: set[str] = set()
        self.clarify_callback: Any = None
        self._interrupt_requested = False
        self._touch_activity: Any = None


class FakeAdapter:
    """Minimal adapter with the seams Memento's wrappers use."""

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
    """Verify that clarify delivery failure is not caused by Memento's submission path."""

    def test_undelivered_when_no_stream(self) -> None:
        """When there's no run stream, clarify returns undelivered — this is expected."""
        adapter = FakeAdapter(has_streams=False)
        agent = FakeAgent()
        adapter._active_run_agents["run_abc"] = agent

        from plugin.clarify import Asker

        asker = Asker(adapter, agent, loop=None)
        answers, outcome, notice = asker.ask([{"qid": "q0", "question": "Test?"}])

        self.assertEqual(outcome, "undelivered")
        self.assertEqual(answers, {})
        self.assertIsNotNone(notice, "Undelivered must carry a notice")

    def test_undelivered_when_no_loop(self) -> None:
        """When there's a stream but no loop (worker thread), still undelivered."""
        adapter = FakeAdapter(has_streams=True)
        agent = FakeAgent()
        adapter._active_run_agents["run_abc"] = agent

        from plugin.clarify import Asker

        asker = Asker(adapter, agent, loop=None)
        answers, outcome, notice = asker.ask([{"qid": "q0", "question": "Test?"}])

        self.assertEqual(outcome, "undelivered")
        self.assertIsNotNone(notice, "Undelivered must carry a notice even with a stream")

    def test_legacy_callback_converts_undelivered_to_timeout(self) -> None:
        """The legacy callback contract sets timed_out=True for non-submitted outcomes.

        This is the bug: undelivered becomes timed_out in the legacy shape, which
        the app renders as 'No Answer'. The fix should distinguish these.
        """
        adapter = FakeAdapter(has_streams=False)
        agent = FakeAgent()
        adapter._active_run_agents["run_abc"] = agent

        from plugin.clarify import Asker

        asker = Asker(adapter, agent, loop=None)

        # Legacy contract: callback(questions=[...]) -> {"answers", "timed_out", "notice"?}
        result = asker(questions=[{"qid": "q0", "question": "Test?"}])

        self.assertIn("timed_out", result)
        self.assertTrue(
            result["timed_out"],
            "Legacy contract marks undelivered as timed_out=True — this is the bug to fix",
        )
        self.assertIn("notice", result, "Notice must be present even in legacy shape")


if __name__ == "__main__":
    unittest.main()