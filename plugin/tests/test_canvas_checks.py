"""Run: python3 -m unittest plugin.tests.test_canvas_checks -v
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from types import ModuleType
from unittest import mock
from unittest.mock import patch

import plugin
from plugin import canvas_checks
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire


def plant_layer(available: bool = True) -> patch:
    """Hermes's browser layer as a host that has it stands in ``sys.modules``.

    ``tools.browser_use_cli`` is imported lazily by the probe, the way the plugin reaches every
    other Hermes module, so a test hands it one: the entry point (``browser_exec``) and the
    availability check (``browser_exec_available``), which is all a probe reads.
    """
    tools = ModuleType("tools")
    cli = ModuleType("tools.browser_use_cli")
    cli.browser_exec = lambda *args, **kwargs: None
    cli.browser_exec_available = lambda: available
    tools.browser_use_cli = cli
    return patch.dict(sys.modules, {"tools": tools, "tools.browser_use_cli": cli})


def take_layer_away() -> patch:
    """A host with no browser layer in reach: both names held as ``None`` in ``sys.modules``, so
    the probe's import of them is halted."""
    return patch.dict(sys.modules, {"tools": None, "tools.browser_use_cli": None})


def plant_unreadable_layer() -> patch:
    """A layer whose availability check can't be read: the entry is there, the read raises."""

    def unreadable() -> bool:
        raise OSError("the layer won't answer")

    tools = ModuleType("tools")
    cli = ModuleType("tools.browser_use_cli")
    cli.browser_exec = lambda *args, **kwargs: None
    cli.browser_exec_available = unreadable
    tools.browser_use_cli = cli
    return patch.dict(sys.modules, {"tools": tools, "tools.browser_use_cli": cli})


class ProbeTest(unittest.TestCase):
    def test_the_layer_in_reach_reads_ready(self) -> None:
        with plant_layer():
            self.assertIsNone(canvas_checks.available())

    def test_no_layer_reads_not_ready_with_the_reason(self) -> None:
        with take_layer_away():
            reason = canvas_checks.available()
        self.assertIsInstance(reason, str)
        self.assertIn("browser", reason)

    def test_a_layer_whose_engine_is_missing_reads_not_ready_with_the_reason(self) -> None:
        with plant_layer(available=False):
            reason = canvas_checks.available()
        self.assertIsInstance(reason, str)
        self.assertIn("hermes update", reason)

    def test_a_layer_that_cant_be_read_answers_rather_than_raises(self) -> None:
        with plant_unreadable_layer():
            self.assertEqual(canvas_checks.UNREADABLE, canvas_checks.available())

    def test_a_layer_that_wont_import_reads_not_ready_with_the_reason(self) -> None:
        class Exploding(ModuleType):
            @property
            def browser_use_cli(self) -> ModuleType:
                raise RuntimeError("the layer won't import")

        with patch.dict(sys.modules, {"tools": Exploding("tools")}):
            self.assertEqual(canvas_checks.UNREADABLE, canvas_checks.available())


class AdvertisedTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_hermes_home(self)
        self.app = wire(self, RouteAdapter())

    def call(self, path: str, method: str = "GET", body: dict | None = None, **match: str) -> dict:
        request = FakeWeb.Request()
        request.match_info, request.headers = match, {}
        request.json = mock.AsyncMock(return_value=body)
        return asyncio.run(route(self.app, plugin.PREFIX + path, method)(request))

    def test_info_advertises_canvas_checks_only_where_the_layer_is_found(self) -> None:
        for found, listed in ((True, True), (False, False)):
            with self.subTest(found=found):
                with patch.object(canvas_checks, "available", return_value=None if found else "no"):
                    features = self.call("/info")["payload"]["features"]
                    self.assertEqual("canvas_checks" in features, listed)


if __name__ == "__main__":
    unittest.main()
