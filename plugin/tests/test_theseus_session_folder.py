"""One Theseus run per multi-repo session, in a folder of its own.

Run: python3 -m unittest plugin.tests.test_theseus_session_folder -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import theseus


class SessionFolderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        fake = types.ModuleType("hermes_constants")
        fake.get_hermes_home = lambda: str(self.home)  # type: ignore[attr-defined]
        patcher = mock.patch.dict(sys.modules, {"hermes_constants": fake})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.trees = [self.home / "web" / ".worktrees" / "x", self.home / "api" / ".worktrees" / "x"]
        for tree in self.trees:
            tree.mkdir(parents=True)
        self.record = {
            "session_id": "memento-1",
            "path": str(self.trees[0]),
            "repos": [
                {"name": "o/web", "path": str(self.trees[0])},
                {"name": "o/api", "path": str(self.trees[1])},
            ],
        }
        self.folder = self.home / "memento" / "theseus" / "memento-1"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_only_a_multi_repo_session_has_one(self) -> None:
        self.assertEqual(theseus.session_folder(self.record), self.folder)
        single = {**self.record, "repos": self.record["repos"][:1]}
        self.assertIsNone(theseus.session_folder(single))
        self.assertIn("top folder", theseus.instructions(single))

    def test_instructions_name_the_folder_and_repos(self) -> None:
        text = theseus.instructions(self.record)
        self.assertIn(f"cd {self.folder} && theseus init --repos web={self.trees[0]},api={self.trees[1]}", text)
        self.assertTrue(self.folder.is_dir())

    def test_repo_names_stay_apart(self) -> None:
        record = {**self.record, "repos": [{"name": "a/web", "path": "/1"}, {"name": "b/web", "path": "/2"}]}
        self.assertEqual(theseus._repo_names(record), [("web", "/1"), ("web2", "/2")])

    def test_run_home_prefers_the_folder(self) -> None:
        for where in (self.trees[1], self.folder):
            current = where / ".theseus" / "current"
            current.mkdir(parents=True)
            (current / "run.json").write_text(json.dumps({"key": "k"}))
        self.assertEqual(theseus.run_home(self.record), str(self.folder))

    def test_refuses_an_init_elsewhere(self) -> None:
        init = {"command": "node theseus.js init --key k"}
        self.assertIsNotNone(theseus.misplaced_init("terminal", init, self.record, str(self.trees[1])))
        self.assertIsNone(theseus.misplaced_init("terminal", init, self.record, str(self.folder)))
        moved = {"command": f"cd {self.folder} && node theseus.js init --key k"}
        self.assertIsNone(theseus.misplaced_init("terminal", moved, self.record, str(self.trees[1])))
        self.assertIsNone(theseus.misplaced_init("terminal", {"command": "node theseus.js status"}, self.record, None))


if __name__ == "__main__":
    unittest.main()
