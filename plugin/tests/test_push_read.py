"""Mark as read in the Android tray: which notices carry it, and the moment it covers.

A run's notice and a routine's message are news the reader receives, so the tray offers Mark as read
on them; a notice that waits on the reader (an approval, a question, a plan) is answered rather than
read, and every other kind is about no chat. The part rides only the relay to Android, beside the
chat it names, and carries ``at``: the host's moment of the activity it reports, which is what a press
covers when the app later moves its read mark.

Run: python3 -m unittest plugin.tests.test_push_read -v
"""

from __future__ import annotations

import time
import unittest
from unittest import mock

from plugin import chats, link, notice, push
from plugin.store import db_path
from plugin.tests._helpers import temp_hermes_home

READ_KINDS = {"run_done", "run_failed", "routine_message"}


class WhichKinds(unittest.TestCase):
    def test_routine_message_and_run_kinds_carry_read_every_other_kind_doesnt(self) -> None:
        self.assertEqual({kind.name for kind in notice.KINDS_TABLE if kind.read}, READ_KINDS)


class TheConversationPart(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        chats.merge(self.path, {"chat-1": {"at": 1, "value": {"title": "Trip", "hermesSessionId": "gots-1"}}})
        patcher = mock.patch.object(link, "load_state", lambda home: {})
        patcher.start()
        self.addCleanup(patcher.stop)

    def part(self, kind: str) -> dict:
        return push._notice(self.path, kind, "gots-1", None, "Booked.", None).conversation

    def test_a_read_kinds_notice_carries_read_and_the_moment_it_covers(self) -> None:
        for kind in sorted(READ_KINDS):
            before = int(time.time() * 1000)
            part = self.part(kind)
            after = int(time.time() * 1000)
            self.assertIs(part.get("read"), True, kind)
            self.assertIsInstance(part.get("at"), int, kind)
            self.assertTrue(before <= part["at"] <= after, f"{kind}: at is the host's moment, in ms")

    def test_any_other_session_kind_carries_neither(self) -> None:
        for kind in notice.SESSION_KINDS:
            if kind in READ_KINDS:
                continue
            part = self.part(kind)
            self.assertEqual(part.get("chat"), "chat-1", "it is still about the chat")
            self.assertNotIn("read", part, kind)
            self.assertNotIn("at", part, kind)

    def test_a_notice_about_no_chat_carries_no_read(self) -> None:
        part = push._notice(self.path, "run_done", "gots-unknown", None, "Booked.", None).conversation
        self.assertNotIn("read", part, "Mark as read moves a chat's mark, so it needs the chat")

    def test_web_push_and_ntfy_never_see_it(self) -> None:
        built = push._notice(self.path, "run_done", "gots-1", None, "Booked.", None)
        self.assertNotIn("read", notice.carried(built))
        self.assertNotIn("at", notice.carried(built))


if __name__ == "__main__":
    unittest.main()
