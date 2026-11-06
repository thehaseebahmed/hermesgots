"""The agent can ask the user on the API server only where the profile's toolsets carry clarify.

Hermes 0.22.5 answers questions itself (the callback, the run control and the answer route), but its
API server toolset, ``hermes-api-server``, leaves ``clarify`` out on purpose. The plugin no longer
rebinds ``_get_platform_tools`` to slip it in (catalog rule 9): ``hermes gots link`` offers to add it
to the profile's ``platform_toolsets.api_server`` through Hermes's own config writer, and only with
the user's yes.

Run: python3 -m unittest plugin.tests.test_clarify -v
"""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

from plugin import clarify, link


class _Adapter:
    def __init__(self, *, native: bool) -> None:
        self.created = []
        if native:
            self._handle_run_clarify = lambda request: None

    def _create_agent(self, *args, **kwargs):
        agent = types.SimpleNamespace(clarify_callback=None, tools=[], valid_tool_names=set())
        self.created.append(agent)
        return agent


def _hermes_config(case: unittest.TestCase, raw: Dict[str, Any]) -> Dict[str, Any]:
    """Hermes's ``hermes_cli.config`` over one in-memory ``config.yaml``: what ``save_config`` was
    handed is merged in, as ``merge_existing=True`` asks."""
    module = types.ModuleType("hermes_cli.config")
    saved: Dict[str, Any] = {"raw": raw, "calls": []}

    def merge(into: Dict[str, Any], new: Dict[str, Any]) -> None:
        for key, value in new.items():
            if isinstance(value, dict) and isinstance(into.get(key), dict):
                merge(into[key], value)
            else:
                into[key] = value

    def save_config(config, **kwargs):
        saved["calls"].append((config, kwargs))
        merge(saved["raw"], config)

    module.read_raw_config = lambda: saved["raw"]  # type: ignore[attr-defined]
    module.load_config = lambda: saved["raw"]  # type: ignore[attr-defined]
    module.save_config = save_config  # type: ignore[attr-defined]
    patcher = mock.patch.dict(
        sys.modules, {"hermes_cli": types.ModuleType("hermes_cli"), "hermes_cli.config": module}
    )
    patcher.start()
    case.addCleanup(patcher.stop)
    return saved


class WireTest(unittest.TestCase):
    def test_nothing_about_agent_creation_is_rebound(self) -> None:
        _hermes_config(self, {"platform_toolsets": {"api_server": ["hermes-api-server", "clarify"]}})
        adapter = _Adapter(native=True)
        original = adapter._create_agent
        self.assertTrue(clarify.wire(adapter))
        self.assertEqual(adapter._create_agent, original)

    def test_a_profile_without_clarify_among_its_toolsets_cannot_ask(self) -> None:
        _hermes_config(self, {})
        self.assertFalse(clarify.wire(_Adapter(native=True)))

    def test_a_user_who_disabled_the_toolset_keeps_it_off(self) -> None:
        _hermes_config(
            self,
            {
                "platform_toolsets": {"api_server": ["hermes-api-server", "clarify"]},
                "agent": {"disabled_toolsets": ["clarify"]},
            },
        )
        self.assertFalse(clarify.wire(_Adapter(native=True)))

    def test_an_older_hermes_gets_no_wrap_either(self) -> None:
        _hermes_config(self, {"platform_toolsets": {"api_server": ["clarify"]}})
        adapter = _Adapter(native=False)
        original = adapter._create_agent
        self.assertFalse(clarify.wire(adapter), "below the plugin's floor; nothing is patched in")
        self.assertEqual(adapter._create_agent, original)

    def test_a_hermes_native_to_clarify_is_told_so(self) -> None:
        self.assertTrue(clarify.native(_Adapter(native=True)))
        self.assertFalse(clarify.native(_Adapter(native=False)))


class LinkConsentTest(unittest.TestCase):
    """``hermes gots link`` writes clarify into the profile's toolsets only after a yes."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)

    def test_an_unsaved_surface_keeps_its_composite_and_gains_clarify(self) -> None:
        saved = _hermes_config(self, {})
        self.assertEqual(link.needs_clarify(self.home), ["hermes-api-server", "clarify"])
        self.assertTrue(link.enable_clarify(self.home))
        self.assertEqual(saved["raw"]["platform_toolsets"]["api_server"], ["hermes-api-server", "clarify"])
        self.assertEqual(saved["calls"][0][1], {"merge_existing": True}, "only the one key is written")

    def test_a_saved_list_keeps_every_toolset_it_had(self) -> None:
        saved = _hermes_config(self, {"platform_toolsets": {"api_server": ["file", "terminal"]}})
        self.assertTrue(link.enable_clarify(self.home))
        self.assertEqual(saved["raw"]["platform_toolsets"]["api_server"], ["file", "terminal", "clarify"])

    def test_a_list_that_already_names_it_is_left_alone(self) -> None:
        saved = _hermes_config(self, {"platform_toolsets": {"api_server": ["clarify"]}})
        self.assertIsNone(link.needs_clarify(self.home))
        self.assertFalse(link.enable_clarify(self.home))
        self.assertEqual(saved["calls"], [])

    def test_a_toolset_the_user_disabled_is_never_turned_back_on(self) -> None:
        saved = _hermes_config(self, {"agent": {"disabled_toolsets": ["clarify"]}})
        self.assertIsNone(link.needs_clarify(self.home))
        self.assertFalse(link.enable_clarify(self.home))
        self.assertEqual(saved["calls"], [])

    def test_a_no_at_the_prompt_writes_nothing(self) -> None:
        saved = _hermes_config(self, {})
        with mock.patch("builtins.input", return_value="n"):
            self.assertFalse(link._confirm("Add clarify?", False))
        self.assertEqual(saved["calls"], [])


if __name__ == "__main__":
    unittest.main()
