"""The session library: where its generated files are filed, and the tool that files them.

Run: python3 -m unittest plugin.tests.test_library -v

"""

from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from plugin import sessions
from plugin.store import db_path


def fake_project(primary: Path) -> SimpleNamespace:
    return SimpleNamespace(folders=[SimpleNamespace(path=str(primary), is_primary=True)])


class FilesDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db = db_path(self.home)
        self.project = fake_project(self.home / "project")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_under_the_primary_folder_named_after_the_worktree(self) -> None:
        self.assertEqual(
            sessions.files_dir(self.project, "hermes/jazzy-quokka-7bfe"),
            str(self.home / "project" / "files" / "jazzy-quokka-7bfe"),
        )
        # A branch without the hermes/ prefix still names the folder.
        self.assertEqual(
            sessions.files_dir(self.project, "main"), str(self.home / "project" / "files" / "main")
        )

    def test_the_record_keeps_it(self) -> None:
        folder = sessions.files_dir(self.project, "hermes/jazzy-quokka-7bfe")
        repos = [
            {
                "name": "o/web",
                "repo_root": str(self.home / "project"),
                "path": str(self.home / "project" / ".worktrees" / "jazzy-quokka-7bfe"),
                "branch": "hermes/jazzy-quokka-7bfe",
            }
        ]
        sessions._upsert(self.db, "memento-1", "p1", repos, "auto", folder)
        record = sessions.read(self.db, "memento-1")
        assert record is not None
        self.assertEqual(record["files_dir"], folder)
        self.assertEqual(record["branch"], "hermes/jazzy-quokka-7bfe")


if __name__ == "__main__":
    unittest.main()
