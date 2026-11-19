"""The model-call timeout: one whole number of seconds the profile's store holds, the route pair
that answers and sets it, and the Research and Meetings calls that read it.

Run: python3 -m unittest plugin.tests.test_model_timeout -v
"""

from __future__ import annotations

import asyncio
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import plugin
from plugin import meetings, model_timeout, research
from plugin.store import db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire


class SettingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = db_path(Path(self.dir.name))

    def test_two_minutes_until_a_bot_says_otherwise(self) -> None:
        self.assertEqual(model_timeout.seconds(self.path), 120)

    def test_a_write_is_read_back(self) -> None:
        self.assertEqual(model_timeout.set_seconds(self.path, 300), 300)
        self.assertEqual(model_timeout.seconds(self.path), 300)

    def test_a_value_outside_the_range_or_not_a_whole_number_is_refused_and_writes_nothing(self) -> None:
        model_timeout.set_seconds(self.path, 180)
        for bad in (29, 1801, 0, -5, 90.5, "120", None, True):
            with self.assertRaises(ValueError, msg=repr(bad)):
                model_timeout.set_seconds(self.path, bad)
        self.assertEqual(model_timeout.seconds(self.path), 180)

    def test_the_ends_of_the_range_are_allowed(self) -> None:
        self.assertEqual(model_timeout.set_seconds(self.path, model_timeout.MIN_S), 30)
        self.assertEqual(model_timeout.set_seconds(self.path, model_timeout.MAX_S), 1800)

    def test_a_stored_value_that_isnt_valid_reads_as_the_default(self) -> None:
        from plugin.store import put_setting

        put_setting(self.path, model_timeout.SETTING, "soon")
        self.assertEqual(model_timeout.seconds(self.path), 120)
        put_setting(self.path, model_timeout.SETTING, 5)
        self.assertEqual(model_timeout.seconds(self.path), 120)

    def test_a_store_that_cant_be_read_reads_as_the_default(self) -> None:
        with mock.patch("plugin.store.get_setting", side_effect=OSError("locked")):
            self.assertEqual(model_timeout.seconds(self.path), 120)


class RouteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.app = wire(self, RouteAdapter())

    def call(self, method: str, body=None):
        request = FakeWeb.Request()
        request.match_info, request.headers, request.query = {}, {}, {}
        request.json = mock.AsyncMock(return_value=body)
        return asyncio.run(route(self.app, plugin.PREFIX + "/model-timeout", method)(request))

    def test_it_answers_the_default_then_what_was_set(self) -> None:
        first = self.call("GET")
        self.assertEqual(first["payload"]["seconds"], 120)
        self.assertEqual(first["payload"]["object"], "gots.model_timeout")
        self.assertEqual(self.call("POST", {"seconds": 240})["payload"]["seconds"], 240)
        self.assertEqual(self.call("GET")["payload"]["seconds"], 240)

    def test_a_refused_value_is_a_400_in_words_and_leaves_the_setting(self) -> None:
        self.call("POST", {"seconds": 240})
        for body in ({"seconds": 5}, {"seconds": "soon"}, {}, None):
            answered = self.call("POST", body)
            self.assertEqual(answered["status"], 400, repr(body))
        self.assertEqual(self.call("GET")["payload"]["seconds"], 240)

    def test_the_feature_is_advertised(self) -> None:
        info = asyncio.run(route(self.app, plugin.PREFIX + "/info", "GET")(self._request()))
        self.assertIn("model_timeout", info["payload"]["features"])

    def _request(self):
        request = FakeWeb.Request()
        request.match_info, request.headers, request.query = {}, {}, {}
        return request


class CallsReadItTest(unittest.TestCase):
    """The setting reaches the call: a bot that set 300 s is asked for 300 s, the next call after a
    change, with no restart."""

    class Llm:
        def __init__(self) -> None:
            self.calls: list = []

        def complete_structured(self, **kwargs):
            self.calls.append(kwargs)
            return types.SimpleNamespace(parsed={"ok": True})

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.llm = self.Llm()
        self.addCleanup(setattr, research, "ctx", getattr(research, "ctx", None))
        research.ctx = types.SimpleNamespace(llm=self.llm)
        patcher = mock.patch.object(meetings, "ctx", types.SimpleNamespace(llm=self.llm))
        patcher.start()
        self.addCleanup(patcher.stop)

    def timeouts(self) -> list:
        return [call["timeout"] for call in self.llm.calls]

    def test_a_research_call_asks_for_the_bots_own_timeout(self) -> None:
        research._structured("brief", "sys", "ins", "text", {"type": "object"})
        model_timeout.set_seconds(self.path, 300)
        research._structured("brief", "sys", "ins", "text", {"type": "object"})
        self.assertEqual(self.timeouts(), [120, 300])

    def test_a_meetings_call_asks_for_the_bots_own_timeout(self) -> None:
        model_timeout.set_seconds(self.path, 45)
        meetings._structured("sys", "text", "notes")
        self.assertEqual(self.timeouts(), [45])


if __name__ == "__main__":
    unittest.main()
