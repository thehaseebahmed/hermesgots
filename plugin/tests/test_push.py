"""A push about a session the app didn't mint: only a chat record makes it the app's news.

A routine's run writes in a session of its own, so it carries none of the ids the app minted and no
ancestor of it does either. Its delivery publishes a chat record naming that session, and that record
is what makes a push about it the app's — without it a routine's row would land in the list with
nothing announcing it.

Run: python3 -m unittest plugin.tests.test_push -v
"""

from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from plugin import chats, push
from plugin.store import db_path

RUN = "cron_job-1_99"


class RoutineRunIsNews(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.path = db_path(self.home)
        # A device that would be told, with no push service to tell it through.
        self.thread = mock.patch.object(push, "threading", mock.Mock())
        self.thread.start()
        self.addCleanup(self.thread.stop)
        reachable = mock.patch.object(push, "reachable", lambda path: True)
        reachable.start()
        self.addCleanup(reachable.stop)
        push._last.clear()

    def _name(self, session=RUN, deleted=False):
        now = int(time.time() * 1000)
        chats.merge(
            self.path,
            {
                f"routine-job-1-{session}": {
                    "at": now,
                    "value": {"title": "Morning watch", "hermesSessionId": session, "routine": True},
                }
            },
        )
        if deleted:
            chats.tombstone(self.path, f"routine-job-1-{session}")

    def _announced(self):
        """The sessions a push was started for, in the order the pushes were taken."""
        return [call.kwargs["args"][2] for call in push.threading.Thread.call_args_list]

    def test_a_runs_session_is_announced_because_a_chat_record_names_it(self):
        self._name()
        self.assertTrue(push.notify("routine_message", RUN, path=self.path))
        self.assertEqual(self._announced(), [RUN])

    def test_a_session_no_chat_record_names_is_nobodys_news(self):
        self.assertFalse(push.notify("routine_message", RUN, path=self.path))
        self.assertEqual(self._announced(), [])

    def test_a_row_the_reader_deleted_names_nothing(self):
        self._name(deleted=True)
        self.assertFalse(push.notify("routine_message", RUN, path=self.path))

    def test_an_app_minted_chat_is_announced_without_asking_the_store(self):
        self.assertTrue(push.notify("routine_message", "gots-a-chat", path=self.path))
        self.assertEqual(self._announced(), ["gots-a-chat"])
