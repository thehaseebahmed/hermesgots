"""The agent can ask the user on the API server: clarify is part of that surface's toolset.

Hermes 0.22.5 rebuilds an agent's tool list from its toolsets and answers ``tool_search`` from them
too, so a tool appended to one agent after it is built is dropped and can't be found. The tool has
to be among the toolsets the API server asks for, and Hermes's own turn runner then supplies the
callback and the answer route. An older Hermes has neither, so there the plugin still wraps agent
creation and answers from its own route.

Run: python3 -m unittest plugin.tests.test_clarify -v
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest import mock

from plugin import clarify


def _tools_config(enabled: set) -> types.ModuleType:
    """Hermes's ``hermes_cli.tools_config`` as ``_create_agent`` imports it on every call."""
    module = types.ModuleType("hermes_cli.tools_config")
    module.calls = []  # type: ignore[attr-defined]

    def get_platform_tools(config, platform, *args, **kwargs):
        module.calls.append(platform)  # type: ignore[attr-defined]
        return set(enabled)

    module._get_platform_tools = get_platform_tools  # type: ignore[attr-defined]
    return module


class _Adapter:
    """The API server adapter: ``_create_agent`` is what a legacy Hermes lets the plugin wrap."""

    def __init__(self, *, native: bool) -> None:
        self.created = []
        if native:
            self._handle_run_clarify = lambda request: None

    def _create_agent(self, *args, **kwargs):
        agent = types.SimpleNamespace(clarify_callback=None, tools=[], valid_tool_names=set())
        self.created.append(agent)
        return agent


class ToolsetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _tools_config({"file", "terminal"})
        patcher = mock.patch.dict(
            sys.modules, {"hermes_cli": types.ModuleType("hermes_cli"), "hermes_cli.tools_config": self.module}
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def enabled(self, platform: str, config: dict | None = None) -> set:
        return self.module._get_platform_tools(config or {}, platform)

    def test_the_api_server_asks_for_clarify_among_its_toolsets(self) -> None:
        self.assertTrue(clarify.include_toolset())
        self.assertEqual(self.enabled("api_server"), {"file", "terminal", "clarify"})

    def test_another_platform_keeps_the_toolsets_it_has(self) -> None:
        clarify.include_toolset()
        self.assertEqual(self.enabled("telegram"), {"file", "terminal"})

    def test_a_user_who_disabled_the_toolset_keeps_it_off(self) -> None:
        clarify.include_toolset()
        config = {"agent": {"disabled_toolsets": ["clarify"]}}
        self.assertEqual(self.enabled("api_server", config), {"file", "terminal"})

    def test_a_toolset_already_enabled_is_left_as_it_is(self) -> None:
        self.module._get_platform_tools = lambda config, platform, *a, **k: {"clarify", "file"}
        clarify.include_toolset()
        self.assertEqual(self.enabled("api_server"), {"clarify", "file"})

    def test_wiring_twice_wraps_once(self) -> None:
        clarify.include_toolset()
        clarify.include_toolset()
        self.enabled("api_server")
        self.assertEqual(self.module.calls, ["api_server"], "Hermes's own lookup ran once per ask")

    def test_a_hermes_without_the_module_has_nothing_to_wire(self) -> None:
        with mock.patch.dict(sys.modules, {"hermes_cli.tools_config": None}):
            self.assertFalse(clarify.include_toolset())


class WireTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _tools_config({"file"})
        patcher = mock.patch.dict(
            sys.modules, {"hermes_cli": types.ModuleType("hermes_cli"), "hermes_cli.tools_config": self.module}
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_hermes_with_native_clarify_keeps_its_own_agents(self) -> None:
        adapter = _Adapter(native=True)
        original = adapter._create_agent
        self.assertTrue(clarify.wire(adapter))
        self.assertEqual(adapter._create_agent, original, "its turn runner supplies the callback")
        self.assertIn("clarify", self.module._get_platform_tools({}, "api_server"))

    def test_an_older_hermes_still_gets_the_plugins_own_callback(self) -> None:
        adapter = _Adapter(native=False)
        self.assertTrue(clarify.wire(adapter))
        agent = adapter._create_agent()
        self.assertIsInstance(agent.clarify_callback, clarify.Asker)

    def test_a_hermes_native_to_clarify_is_told_so(self) -> None:
        self.assertTrue(clarify.native(_Adapter(native=True)))
        self.assertFalse(clarify.native(_Adapter(native=False)))


if __name__ == "__main__":
    unittest.main()
