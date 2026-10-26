"""The chat list's draft text and picked mode, and the size cap they fit under.

Run: python3 -m unittest plugin.tests.test_chats -v
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from plugin import chats
from plugin.store import db_path


class DraftsAndModes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))

    def test_a_newer_record_carries_its_draft_and_mode(self):
        chats.merge(self.path, {"a": {"at": 1, "value": {"draftText": "old", "mode": "accept_edits"}}})
        merged = chats.merge(self.path, {"a": {"at": 2, "value": {"draftText": "new", "mode": "plan"}}})
        self.assertEqual(merged["a"]["value"], {"draftText": "new", "mode": "plan"})

    def test_an_older_record_does_not_overwrite_the_draft(self):
        chats.merge(self.path, {"a": {"at": 5, "value": {"draftText": "kept"}}})
        merged = chats.merge(self.path, {"a": {"at": 2, "value": {"draftText": "stale"}}})
        self.assertEqual(merged["a"]["value"]["draftText"], "kept")

    def test_a_twenty_kb_draft_is_accepted(self):
        merged = chats.merge(self.path, {"a": {"at": 1, "value": {"draftText": "x" * (20 * 1024)}}})
        self.assertEqual(len(merged["a"]["value"]["draftText"]), 20 * 1024)

    def test_a_record_over_64_kb_is_rejected_whole(self):
        with self.assertRaises(chats.InvalidChats):
            chats.merge(
                self.path,
                {"a": {"at": 1, "value": {"draftText": "x" * (64 * 1024)}}, "b": {"at": 1, "value": {}}},
            )
        self.assertEqual(chats.read(self.path), {})


class EndingChats(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))
        chats.merge(self.path, {"c1": {"at": 1, "value": {"hermesSessionId": "memento-other"}}})

    def test_a_deleted_chat_names_the_session_its_record_held(self):
        found = chats.ending(self.path, {"c1": {"at": 2, "deleted": True}})
        self.assertEqual(found, ["memento-other", "memento-c1", "c1"])

    def test_a_discarded_chat_ends_its_work_but_a_resolved_one_does_not(self):
        self.assertEqual(
            chats.ending(self.path, {"c1": {"at": 2, "value": {"resolvedAt": 5}}}), []
        )
        found = chats.ending(self.path, {"c1": {"at": 2, "value": {"discardedAt": 5}}})
        self.assertIn("memento-other", found)

    def test_a_record_the_merge_would_not_take_ends_nothing(self):
        self.assertEqual(chats.ending(self.path, {"c1": {"at": 1, "deleted": True}}), [])

    def test_a_chat_already_ended_or_never_seen_ends_nothing(self):
        chats.merge(self.path, {"c1": {"at": 2, "deleted": True}})
        self.assertEqual(chats.ending(self.path, {"c1": {"at": 3, "deleted": True}}), [])
        self.assertEqual(chats.ending(self.path, {"new": {"at": 3, "deleted": True}}), [])


if __name__ == "__main__":
    unittest.main()
