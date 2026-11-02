"""Tests for the plugin's opt-in error reporting (``plugin/reporting.py``).

``sentry_sdk`` is stood in for through ``sys.modules`` (the ``test_mcp.py`` pattern), so each test
asserts only this module's own rules: nothing starts without a DSN, a host without the SDK is told
once and carries on, an init that does happen carries no personal data and no request body, the
logged exception is what reaches it, and a second call starts nothing twice.

Run: python3 -m unittest plugin.tests.test_reporting -v
"""

from __future__ import annotations

import logging
import types
import unittest
from unittest import mock

from plugin import reporting


class FakeLoggingIntegration:
    """The one piece of the SDK's logging integration this module names."""

    def __init__(self, level=None, event_level=None) -> None:
        self.level = level
        self._event_level = event_level


class FakeSentry:
    """What ``sentry_sdk`` is asked to do, recorded rather than sent."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def init(self, **options) -> None:
        self.calls.append(options)


class ReportingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = FakeSentry()
        reporting._started = False
        patcher = mock.patch.dict("sys.modules")
        self.modules = patcher.start()
        self.addCleanup(patcher.stop)
        sdk = types.ModuleType("sentry_sdk")
        sdk.init = self.fake.init
        integrations = types.ModuleType("sentry_sdk.integrations")
        logging_module = types.ModuleType("sentry_sdk.integrations.logging")
        logging_module.LoggingIntegration = FakeLoggingIntegration
        sdk.integrations = integrations
        integrations.logging = logging_module
        self.modules["sentry_sdk"] = sdk
        self.modules["sentry_sdk.integrations"] = integrations
        self.modules["sentry_sdk.integrations.logging"] = logging_module

    def test_nothing_starts_without_a_dsn(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertFalse(reporting.start("0.97.1"))
        self.assertEqual(self.fake.calls, [], "no DSN, nowhere to send")

    def test_a_host_with_the_dsn_and_no_sdk_is_told_once_and_carries_on(self) -> None:
        self.modules.pop("sentry_sdk")
        self.modules.pop("sentry_sdk.integrations")
        self.modules.pop("sentry_sdk.integrations.logging")
        with mock.patch.dict("os.environ", {reporting.DSN_ENV: "https://key@host/2"}, clear=True):
            with self.assertLogs("plugin.reporting", level="INFO") as logs:
                self.assertFalse(reporting.start("0.97.1"))
        self.assertIn("sentry-sdk is not installed", logs.output[0])

    def test_a_report_names_the_plugin_build_and_carries_no_personal_data(self) -> None:
        with mock.patch.dict(
            "os.environ", {reporting.DSN_ENV: "https://key@host/2"}, clear=True
        ):
            self.assertTrue(reporting.start("0.97.1"))
        (options,) = self.fake.calls
        self.assertEqual(options["dsn"], "https://key@host/2")
        self.assertEqual(options["release"], "gots-plugin@0.97.1")
        self.assertEqual(options["environment"], "production")
        self.assertFalse(options["send_default_pii"])
        self.assertEqual(options["max_request_body_size"], "never")
        self.assertFalse(options["include_local_variables"])
        self.assertEqual(options["traces_sample_rate"], 0.0)

    def test_a_logged_exception_is_what_reaches_it(self) -> None:
        with mock.patch.dict("os.environ", {reporting.DSN_ENV: "https://key@host/2"}, clear=True):
            reporting.start("0.97.1")
        (integration,) = self.fake.calls[0]["integrations"]
        self.assertEqual(integration._event_level, logging.ERROR, "an error is an event")

    def test_an_event_loses_the_request_it_was_carrying(self) -> None:
        event = {
            "request": {
                "url": "https://bot.example/v1/sessions/abc/messages",
                "headers": {"authorization": "Bearer secret"},
                "cookies": {"session": "abc"},
                "data": {"message": "what the user typed"},
                "method": "GET",
            },
            "user": {"id": "someone"},
        }
        kept = reporting.scrub(event, {})
        self.assertEqual(kept["request"], {"url": "https://bot.example/v1/sessions/abc/messages", "method": "GET"})
        self.assertNotIn("user", kept)

    def test_a_second_call_starts_nothing_twice(self) -> None:
        with mock.patch.dict("os.environ", {reporting.DSN_ENV: "https://key@host/2"}, clear=True):
            self.assertTrue(reporting.start("0.97.1"))
            self.assertFalse(reporting.start("0.97.1"))
        self.assertEqual(len(self.fake.calls), 1)


if __name__ == "__main__":
    unittest.main()
