"""Which approvals reach a closed app: the ones a person is asked to answer.

Run: python3 -m unittest plugin.tests.test_approval_notice -v
"""

from __future__ import annotations

import unittest
from unittest import mock

from plugin import events


class NoticeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sent: list = []
        self.noted: list = []
        for patcher in (
            mock.patch.dict(events._api_sessions, {}, clear=True),
            mock.patch.object(events.push, "notify", lambda kind, *a, **kw: self.sent.append((kind, a))),
            mock.patch.object(events, "note", lambda kind, *a, **kw: self.noted.append((kind, a))),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        events.on_turn_start(session_id="sess_1", platform="api_server")
        self.noted.clear()
        self.request = {
            "session_id": "sess_1",
            "session_key": "run_1",
            "command": "rm -rf ./build",
            "pattern_key": "rm_rf",
        }

    def test_an_auto_approved_command_wakes_nothing(self) -> None:
        events.on_approval_request(surface="smart", **self.request)
        self.assertEqual((self.noted, self.sent), ([], []), "no refetch, and no notification to open")

    def test_the_guardians_own_decision_wakes_nothing(self) -> None:
        events.on_approval(choice="smart_deny", **self.request)
        self.assertEqual(self.noted, [])

    def test_an_answer_to_a_real_request_wakes_the_app(self) -> None:
        events.on_approval(choice="once", **self.request)
        self.assertEqual(self.noted, [("runs", ("sess_1",))])

    def test_an_escalated_command_tells_the_device_once(self) -> None:
        events.on_approval_request(surface="smart", **self.request)
        events.on_approval_request(surface="gateway", **self.request)
        self.assertEqual(self.sent, [("approval", ("sess_1",))])

    def test_a_guardian_pass_with_no_session_wakes_nothing(self) -> None:
        events.on_approval_request(surface="smart", command="rm -rf ./build")
        self.assertEqual((self.noted, self.sent), ([], []))

    def test_the_wait_itself_tells_the_device(self) -> None:
        events.on_approval_request(surface="gateway", **self.request)
        self.assertEqual(self.noted, [("runs", ("sess_1",))])
        self.assertEqual(self.sent, [("approval", ("sess_1",))])

    def test_a_session_that_is_not_the_api_servers_sends_nothing(self) -> None:
        events.on_approval_request(surface="cli", session_id="a_cli_session", session_key="run_1")
        self.assertEqual(self.sent, [])

    def test_a_host_that_names_no_surface_still_tells_the_device(self) -> None:
        events.on_approval_request(**self.request)
        self.assertEqual(self.sent, [("approval", ("sess_1",))])


if __name__ == "__main__":
    unittest.main()
