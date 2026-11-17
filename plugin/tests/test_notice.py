"""What a notification says, and what it is about: the one kind table, and the news that is gone.

Run: python3 -m unittest plugin.tests.test_notice -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import chats, merges, notice
from plugin.store import connect, db_path


class NoPullRequestNews(unittest.TestCase):
    """G1: nothing about a pull request notifies — not its checks, not its merge, not an AFK one."""

    def test_no_kind_names_a_pull_request(self):
        self.assertEqual(
            [kind for kind in notice.KINDS if "pr" in kind.split("_")],
            [],
            "no kind is a pull request's news",
        )
        self.assertEqual(
            [kind for kind, words in notice.WORDS.items() if "pull request" in words.lower()],
            [],
            "and none of them says one happened",
        )

    def test_no_category_names_a_pull_request(self):
        self.assertEqual(
            [category for category in notice.CATEGORIES if "pr" in category.split("_")],
            [],
            "so no device switches on news nothing sends",
        )


class MergedPullRequest(unittest.TestCase):
    """A merge still resolves its session; it just doesn't say so any more."""

    def merged(self, pushed):
        """A project session whose pull request GitHub answers as merged, and what it told."""
        home = Path(self.tmp.name)
        path = db_path(home)
        conn = connect(path)
        conn.execute(
            "INSERT INTO project_sessions (session_id, project_id, repo_root, path, branch, mode,"
            " plan_pending, created_at, repos) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)",
            (
                "sess-1",
                "p1",
                "/repo",
                "/repo",
                "hermes/sess-1",
                "auto",
                json.dumps(
                    [{"name": "repo", "repo_root": "/repo", "path": "/repo", "branch": "hermes/sess-1"}]
                ),
            ),
        )
        conn.commit()
        conn.close()
        chats.merge(
            path,
            {"chat-1": {"at": 1, "value": {"projectId": "p1", "hermesSessionId": "sess-1", "updatedAt": 1}}},
        )
        with mock.patch.object(
            merges.github,
            "pull_request",
            lambda home, root, branch, **_: {"repo": "o/r", "number": 7, "state": "merged"},
        ), mock.patch("plugin.push.notify", lambda *args, **kwargs: pushed.append(args)):
            return merges.check(home, now=1000)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_a_merged_pull_request_resolves_its_chat_and_pushes_nothing(self):
        pushed = []
        resolved = self.merged(pushed)
        self.assertEqual(resolved, 1, "the merged session is closed on every device")
        entry = chats.one(db_path(Path(self.tmp.name)), "chat-1")
        self.assertEqual(entry["value"]["resolvedAt"], 1000, "with nobody's clock in the answer")
        self.assertEqual(pushed, [], "and nothing about a merge notifies")


if __name__ == "__main__":
    unittest.main()
