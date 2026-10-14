"""The session library: where its generated files are filed, and the tool that files them.

Run: python3 -m unittest plugin.tests.test_library -v

"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from plugin import library, prompt_builder, sessions
from plugin.store import db_path
from plugin.tests._helpers import stub_projects_db


def fake_project(primary: Path) -> SimpleNamespace:
    return SimpleNamespace(id="p1", folders=[SimpleNamespace(path=str(primary), is_primary=True)])


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

    def test_ensure_fills_a_row_from_before_the_column(self) -> None:
        # A pre-v15 row whose worktrees all exist takes ensure's early return: the folder is
        # filled then, so the instructions name it and the tool doesn't resolve it every call.
        worktree = self.home / "project" / ".worktrees" / "jazzy-quokka-7bfe"
        worktree.mkdir(parents=True)
        (self.home / "project" / ".git").mkdir(parents=True)
        (self.home / "projects.db").write_bytes(b"")
        repos = [
            {
                "name": "o/web",
                "repo_root": str(self.home / "project"),
                "path": str(worktree),
                "branch": "hermes/jazzy-quokka-7bfe",
            }
        ]
        sessions._upsert(self.db, "memento-1", "p1", repos, "auto", None)
        with stub_projects_db([self.project]):
            record = sessions.ensure(self.db, self.home, "memento-1", "p1", None, None)
        self.assertEqual(
            record["files_dir"], str(self.home / "project" / "files" / "jazzy-quokka-7bfe")
        )
        stored = sessions.read(self.db, "memento-1")
        assert stored is not None
        self.assertEqual(stored["files_dir"], record["files_dir"])


class LibraryAddTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db = db_path(self.home)
        fake = types.ModuleType("hermes_constants")
        fake.get_hermes_home = lambda: str(self.home)  # type: ignore[attr-defined]
        patcher = mock.patch.dict(sys.modules, {"hermes_constants": fake})
        patcher.start()
        self.addCleanup(patcher.stop)
        # The project's primary folder is itself a repo, like a real clone.
        self.project = self.home / "project"
        (self.project / ".git").mkdir(parents=True)
        self.worktree = self.project / ".worktrees" / "jazzy-quokka-7bfe"
        self.worktree.mkdir(parents=True)
        (self.worktree / "shot.png").write_bytes(b"png")
        self.files_dir = self.project / "files" / "jazzy-quokka-7bfe"
        repos = [
            {
                "name": "o/web",
                "repo_root": str(self.project),
                "path": str(self.worktree),
                "branch": "hermes/jazzy-quokka-7bfe",
            }
        ]
        sessions._upsert(self.db, "memento-1", "p1", repos, "auto", str(self.files_dir))
        # The library folder resolves from the project, so projects.db is stubbed for every call.
        (self.home / "projects.db").write_bytes(b"")
        projects_patcher = stub_projects_db([fake_project(self.project)])
        projects_patcher.start()
        self.addCleanup(projects_patcher.stop)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _call(self, path: str, folder: str = "screenshots", task_id: str = "memento-1") -> dict:
        return json.loads(library.handle({"path": path, "folder": folder}, task_id=task_id))

    def test_a_relative_path_moves_out_of_the_worktree(self) -> None:
        result = self._call("shot.png")
        self.assertEqual(result["name"], "shot.png")
        self.assertEqual(result["path"], str(self.files_dir / "screenshots" / "shot.png"))
        self.assertTrue((self.files_dir / "screenshots" / "shot.png").is_file())
        self.assertFalse((self.worktree / "shot.png").exists())

    def test_an_absolute_path_outside_the_worktree_works(self) -> None:
        outside = self.home / "elsewhere" / "report.md"
        outside.parent.mkdir()
        outside.write_text("report", encoding="utf-8")
        result = self._call(str(outside), "reports")
        self.assertEqual(result["path"], str(self.files_dir / "reports" / "report.md"))
        self.assertFalse(outside.exists())

    def test_the_folder_is_made_and_kept_out_of_git(self) -> None:
        self.assertFalse(self.files_dir.exists())
        self._call("shot.png", "reports")
        self.assertTrue((self.files_dir / "reports").is_dir())
        exclude = self.project / ".git" / "info" / "exclude"
        self.assertIn("files/", exclude.read_text(encoding="utf-8").splitlines())

    def test_a_name_already_in_the_folder_is_an_error(self) -> None:
        self.files_dir.joinpath("screenshots").mkdir(parents=True)
        self.files_dir.joinpath("screenshots", "shot.png").write_bytes(b"older")
        self.assertEqual(
            self._call("shot.png"),
            {"error": "shot.png is already in screenshots; rename the file and call again."},
        )
        # Nothing moved and nothing was renamed: the agent renames the file itself.
        self.assertEqual(
            self.files_dir.joinpath("screenshots", "shot.png").read_bytes(), b"older"
        )
        self.assertTrue((self.worktree / "shot.png").is_file())

    def test_a_folder_is_required(self) -> None:
        result = json.loads(library.handle({"path": "shot.png"}, task_id="memento-1"))
        self.assertEqual(result, {"error": "folder is required."})

    def test_a_folder_with_a_path_separator_is_rejected(self) -> None:
        for bad in ("a/b", "..", ".hidden", "a" * 121):
            result = self._call("shot.png", bad)
            self.assertEqual(
                result, {"error": "folder must be a single folder name (no path separators)."}
            )

    def test_a_missing_file_is_an_error(self) -> None:
        self.assertEqual(self._call("nope.png"), {"error": "No such file."})
        self.assertFalse(self.files_dir.exists())

    def test_a_record_from_before_the_column_still_files_it(self) -> None:
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE project_sessions SET files_dir = NULL WHERE session_id = 'memento-1'")
        result = self._call("shot.png", "screenshots")
        self.assertEqual(result["path"], str(self.files_dir / "screenshots" / "shot.png"))

    def test_no_session_is_an_error(self) -> None:
        self.assertEqual(
            json.loads(library.handle({"path": "shot.png", "folder": "screenshots"}, task_id="nope")),
            {"error": "This session has no library to file in."},
        )


class InstructionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.tree = self.home / "project" / ".worktrees" / "jazzy-quokka-7bfe"
        self.tree.mkdir(parents=True)
        self.record = {
            "session_id": "memento-1",
            "path": str(self.tree),
            "branch": "hermes/jazzy-quokka-7bfe",
            "files_dir": str(self.home / "project" / "files" / "jazzy-quokka-7bfe"),
            "repos": [
                {
                    "name": "o/web",
                    "repo_root": str(self.home / "project"),
                    "path": str(self.tree),
                    "branch": "hermes/jazzy-quokka-7bfe",
                }
            ],
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_line_names_the_folder_right_after_the_worktree_line(self) -> None:
        text = prompt_builder.session_prompt(self.record)
        self.assertIn(f"this session's library at {self.record['files_dir']}", text)
        self.assertIn("library_add tool", text)
        self.assertLess(text.index("library at"), text.index("open_pull_request tool"))

    def test_a_record_without_the_folder_has_no_line(self) -> None:
        legacy = {**self.record, "files_dir": None}
        self.assertNotIn("library", prompt_builder.session_prompt(legacy))


if __name__ == "__main__":
    unittest.main()
