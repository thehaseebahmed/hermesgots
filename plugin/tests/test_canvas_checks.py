"""Run: python3 -m unittest plugin.tests.test_canvas_checks -v
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest import mock
from unittest.mock import patch

import plugin
from plugin import canvas_checks
from plugin.tests._helpers import (
    FakeWeb,
    RouteAdapter,
    plant_layer,
    plant_layer_with_no_probe,
    plant_layer_without_wrapper,
    plant_runner,
    plant_unreadable_layer,
    route,
    take_layer_away,
    temp_hermes_home,
    wire,
)

# A draft a build would hand a check: a page that reads its canvas's data and counts a tap.
PAGE = """<!DOCTYPE html>
<html><head><title>Tracker</title></head>
<body><div id="count">0</div><button id="plus">Add one</button>
<script>
var n = 0;
document.getElementById("plus").addEventListener("click", function () {
  n += 1;
  document.getElementById("count").textContent = String(n);
});
window.canvas.data.list("tasks").then(function (rows) {
  document.getElementById("count").textContent = String(rows.length);
});
</script></body></html>"""

# The canvas's data, as a snapshot a check is answered from.
DATA = {"tasks": [{"collection": "tasks", "id": "a", "doc": {"title": "one"}, "at": 1}]}

# The tests a build's plan filed: one that passes, and one the page breaks.
TESTS = [
    {"name": "the counter reads the snapshot", "script": "return 1"},
    {"name": "the page breaks it", "script": "throw new Error('the page broke it')"},
]


def page_answer(request):
    """What the harness page answers for a page that breaks one of its tests: the tests the request
    carries, the one whose script throws answered with what it threw, and the page's own console."""
    tests = []
    for one in request["tests"]:
        broken = "throw" in one["script"]
        tests.append(
            {
                "name": one["name"],
                "ok": not broken,
                "error": "the page broke it" if broken else None,
            }
        )
    return {"tests": tests, "console": ["error: the page said something"]}


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

    def test_a_layer_with_no_wrapper_reads_the_engine_itself(self) -> None:
        with plant_layer_without_wrapper():
            self.assertIsNone(canvas_checks.available())

    def test_a_layer_with_no_wrapper_and_no_engine_reads_not_ready(self) -> None:
        with plant_layer_without_wrapper(engine=False):
            self.assertEqual(canvas_checks.NO_ENGINE, canvas_checks.available())

    def test_a_layer_exporting_neither_probe_name_reads_not_ready(self) -> None:
        with plant_layer_with_no_probe():
            self.assertEqual(canvas_checks.NO_ENTRY, canvas_checks.available())

    def test_the_wrapper_answers_where_a_layer_holds_both(self) -> None:
        # An install with two generations in reach could carry both names; the wrapper is the
        # generation's own verdict, so its "no engine" is the answer even where the private
        # check would find one.
        tools = ModuleType("tools")
        cli = ModuleType("tools.browser_use_cli")
        cli.browser_exec = lambda *args, **kwargs: None
        cli.browser_exec_available = lambda: False
        cli._harness_site_dir = lambda: "/opt/hermes/.venv/lib/python3.14/site-packages"
        tools.browser_use_cli = cli
        with patch.dict(sys.modules, {"tools": tools, "tools.browser_use_cli": cli}):
            self.assertEqual(canvas_checks.NO_ENGINE, canvas_checks.available())

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


class CheckTest(unittest.TestCase):
    """The runner over Hermes's browser layer: what it hands the page, and what it answers."""

    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.folder, ignore_errors=True))

    def run_check(self, answer=None):
        # The layer the runner calls into, planted whole: `plant_runner` already carries the
        # availability check the probe reads, so a second plant would only take the entry point away.
        planted = plant_runner(answer)
        self.addCleanup(planted.stop)
        with planted:
            return canvas_checks.check(PAGE, DATA, TESTS, self.folder), planted

    def test_a_page_that_breaks_a_test_answers_it_failing_and_shoots_four_ways(self) -> None:
        report, _ = self.run_check(page_answer)
        self.assertTrue(report.ran, report.reason)
        # One test passes, one fails with the words the page gave, and the console's errors ride
        # beside them.
        self.assertEqual(
            report.tests,
            [
                {"name": "the counter reads the snapshot", "ok": True, "error": None},
                {"name": "the page breaks it", "ok": False, "error": "the page broke it"},
            ],
        )
        self.assertEqual(report.console, ["error: the page said something"])
        self.assertFalse(report.passing)
        # G8: a phone and a tablet, in the reader's light and dark mode — four screenshots, each
        # named for the drawing it was taken at.
        self.assertEqual(
            [(shot.width, shot.mode) for shot in report.shots],
            [(390, "light"), (390, "dark"), (768, "light"), (768, "dark")],
        )
        for shot in report.shots:
            self.assertTrue(Path(shot.path).is_file(), f"{shot.path} was not written")

    def test_a_page_whose_tests_all_pass_answers_them_passing(self) -> None:
        report, _ = self.run_check(lambda request: {"tests": [
            {"name": one["name"], "ok": True, "error": None} for one in request["tests"]
        ], "console": []})
        self.assertTrue(report.passing)
        self.assertEqual(len(report.tests), 2)

    def test_the_runner_hands_the_page_the_document_the_snapshot_and_the_tests(self) -> None:
        report, planted = self.run_check(page_answer)
        self.assertTrue(report.ran, report.reason)
        # One program for the whole check, carrying the request once: the document, the snapshot and
        # the tests, so a 256 KB page is not four copies in the program the layer runs.
        self.assertEqual(len(planted.programs), 1)
        program = planted.programs[0]
        self.assertEqual(program["request"], {"html": PAGE, "data": DATA, "tests": TESTS})
        # The harness page is opened as a local file, and the four drawings are asked for by name.
        self.assertIn(canvas_checks.HARNESS.as_uri(), program["code"])
        for width, _height, mode in canvas_checks.DRAWINGS:
            self.assertIn(mode, program["code"])
        self.assertIn(str(390), program["code"])
        self.assertIn(str(768), program["code"])
        # One session and one bound, so a slow host's four renders are inside the layer's own timeout.
        self.assertEqual(program["session"], canvas_checks.SESSION)
        self.assertEqual(program["timeout_s"], canvas_checks.CHECK_TIMEOUT_S)

    def test_a_host_with_no_browser_answers_the_reason_and_no_shots(self) -> None:
        with take_layer_away():
            report = canvas_checks.check(PAGE, DATA, TESTS, self.folder)
        self.assertFalse(report.ran)
        self.assertIn("browser", report.reason)
        self.assertEqual(report.shots, [])

    def test_a_host_whose_engine_is_missing_answers_the_reason(self) -> None:
        with plant_layer(available=False):
            report = canvas_checks.check(PAGE, DATA, TESTS, self.folder)
        self.assertEqual(report.reason, canvas_checks.NO_ENGINE)
        self.assertEqual(report.shots, [])

    def test_a_plugin_with_no_harness_answers_the_reason(self) -> None:
        with plant_layer(), patch.object(canvas_checks, "HARNESS", self.folder / "gone.html"):
            report = canvas_checks.check(PAGE, DATA, TESTS, self.folder)
        self.assertEqual(report.reason, canvas_checks.NO_HARNESS)
        self.assertEqual(report.shots, [])

    def test_a_layer_that_refuses_is_answered_rather_than_raised(self) -> None:
        def refusing(code, session="", timeout_s=0, **kwargs):
            return json.dumps({"error": "browser-harness is missing from Hermes's Python environment."})

        with plant_runner(), plant_layer():
            with patch.object(canvas_checks, "_layer", lambda: refusing):
                report = canvas_checks.check(PAGE, DATA, TESTS, self.folder)
        self.assertEqual(
            report.reason,
            "browser-harness is missing from Hermes's Python environment.",
        )
        self.assertEqual(report.shots, [])

    def test_a_layer_that_raises_is_answered_rather_than_raised(self) -> None:
        def exploding(code, session="", timeout_s=0, **kwargs):
            raise OSError("the daemon is gone")

        with plant_layer():
            with patch.object(canvas_checks, "_layer", lambda: exploding):
                report = canvas_checks.check(PAGE, DATA, TESTS, self.folder)
        self.assertEqual(report.reason, canvas_checks.FAILED)

    def test_a_check_that_prints_nothing_readable_answers_the_reason(self) -> None:
        def silent(code, session="", timeout_s=0, **kwargs):
            return json.dumps({"success": True, "exit_code": 0, "output": "not json at all"})

        with plant_layer():
            with patch.object(canvas_checks, "_layer", lambda: silent):
                report = canvas_checks.check(PAGE, DATA, TESTS, self.folder)
        self.assertEqual(report.reason, canvas_checks.NO_ANSWER)


if __name__ == "__main__":
    unittest.main()
