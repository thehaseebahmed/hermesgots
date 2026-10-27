"""The session library: where its generated files are filed, and the tool that files them.

Run: python3 -m unittest plugin.tests.test_library -v

"""

from __future__ import annotations

import json
import os
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
        self.files_dir.joinpath("library-tab").mkdir(parents=True)
        self.files_dir.joinpath("library-tab", "shot.png").write_bytes(b"older")
        result = self._call("shot.png", "library-tab")
        self.assertIn("shot.png is already in library-tab", result["error"])
        self.assertIn("Rename the file", result["error"])
        # Nothing moved and nothing was renamed: the agent renames the file itself.
        self.assertEqual(
            self.files_dir.joinpath("library-tab", "shot.png").read_bytes(), b"older"
        )
        self.assertTrue((self.worktree / "shot.png").is_file())

    def test_a_folder_is_required(self) -> None:
        result = json.loads(library.handle({"path": "shot.png"}, task_id="memento-1"))
        self.assertEqual(result, {"error": "folder is required."})

    def test_a_folder_must_be_a_kebab_case_slug(self) -> None:
        result = self._call("shot.png", "Library Tab")
        self.assertIn("'Library Tab' is not a slug", result["error"])
        self.assertIn("kebab-case: lowercase words joined by single hyphens", result["error"])
        # The naming rule and the correction, so the next call is right the first time.
        self.assertIn("name the folder after the flow", result["error"])
        self.assertIn("Call again with folder 'library-tab'.", result["error"])
        # Nothing was filed and no folder was made for a rejected name.
        self.assertFalse(self.files_dir.exists())
        self.assertTrue((self.worktree / "shot.png").is_file())

    def test_bad_folders_are_rejected_with_the_correction(self) -> None:
        for bad, fixed in [
            ("Screenshots", "screenshots"),
            ("library_tab", "library-tab"),
            ("libraryTab", "library-tab"),
            ("a/b", "a-b"),
            ("..", None),
            (".hidden", "hidden"),
            ("--leading", "leading"),
        ]:
            result = self._call("shot.png", bad)
            self.assertIn(f"{bad!r} is not a slug", result["error"])
            if fixed:
                self.assertIn(f"Call again with folder '{fixed}'.", result["error"])
            else:
                self.assertNotIn("Call again with", result["error"])

    def test_a_folder_over_the_name_limit_is_rejected(self) -> None:
        result = self._call("shot.png", "a" * 121)
        self.assertEqual(result, {"error": "folder must be at most 120 characters."})

    def test_a_file_name_must_be_a_slug_with_an_extension(self) -> None:
        (self.worktree / "Dashboard Light.png").write_bytes(b"png")
        result = self._call("Dashboard Light.png")
        self.assertIn("'Dashboard Light.png' is not a slug with an extension", result["error"])
        self.assertIn("dashboard-light.png", result["error"])
        self.assertIn("Rename the file on disk", result["error"])
        self.assertFalse(self.files_dir.exists())

    def test_a_file_name_needs_exactly_one_extension(self) -> None:
        for name in ("noext", "report.final.md", ".png"):
            (self.worktree / name).write_bytes(b"x")
            result = self._call(name)
            self.assertIn(f"{name!r} is not a slug with an extension", result["error"])

    def test_a_kebab_file_name_files_fine(self) -> None:
        (self.worktree / "dashboard-light.png").write_bytes(b"png")
        result = self._call("dashboard-light.png", "library-tab")
        self.assertEqual(
            result["path"], str(self.files_dir / "library-tab" / "dashboard-light.png")
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


class TreeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "files"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write(self, relative: str, at: int) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
        os.utime(path, (at / 1000, at / 1000))
        return path

    def test_files_group_by_folder_newest_first(self) -> None:
        older = self._write("jazzy-quokka-7bfe/screenshots/old.png", 1000)
        newer = self._write("jazzy-quokka-7bfe/screenshots/new.png", 2000)
        self._write("jazzy-quokka-7bfe/reports/notes.md", 1500)
        tree = library.tree(self.root)
        self.assertEqual([folder["name"] for folder in tree], ["reports", "screenshots"])
        shots = tree[1]["files"]
        self.assertEqual([f["name"] for f in shots], ["new.png", "old.png"])
        self.assertEqual(shots[0]["path"], str(newer))
        self.assertEqual(shots[0]["worktree"], "jazzy-quokka-7bfe")
        self.assertEqual(shots[0]["folder"], "screenshots")
        self.assertEqual(shots[0]["size"], 1)
        # Epoch ms, the unit the app's formatRelative reads.
        self.assertEqual(shots[0]["at"], 2000)
        self.assertEqual(older.parent, newer.parent)

    def test_a_file_with_no_folder_groups_under_its_worktree(self) -> None:
        # Filed before folders existed: it keeps its worktree's name as the group.
        self._write("jazzy-quokka-7bfe/legacy.png", 1000)
        tree = library.tree(self.root)
        self.assertEqual([folder["name"] for folder in tree], ["jazzy-quokka-7bfe"])
        self.assertIsNone(tree[0]["files"][0]["folder"])

    def test_a_worktree_filters_to_its_own_files(self) -> None:
        self._write("jazzy-quokka-7bfe/screenshots/a.png", 1000)
        self._write("cosmic-otter-9f2e/screenshots/a.png", 1000)
        tree = library.tree(self.root, "cosmic-otter-9f2e")
        self.assertEqual([folder["name"] for folder in tree], ["screenshots"])
        self.assertEqual(tree[0]["files"][0]["worktree"], "cosmic-otter-9f2e")

    def test_the_walk_is_capped(self) -> None:
        for n in range(library.MAX_FILES + 5):
            self._write(f"jazzy-quokka-7bfe/screenshots/{n}.png", n)
        tree = library.tree(self.root)
        self.assertEqual(sum(len(folder["files"]) for folder in tree), library.MAX_FILES)

    def test_a_worktree_walk_caps_its_own_files(self) -> None:
        # Another session's files are never walked, so they can't push this one's out of the cap.
        for n in range(library.MAX_FILES + 5):
            self._write(f"jazzy-quokka-7bfe/screenshots/{n}.png", n)
        self._write("cosmic-otter-9f2e/library-tab/only.png", 1)
        tree = library.tree(self.root, "cosmic-otter-9f2e")
        self.assertEqual([[f["name"] for f in folder["files"]] for folder in tree], [["only.png"]])

    def test_an_empty_root_is_an_empty_tree(self) -> None:
        self.assertEqual(library.tree(self.root), [])


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

    def test_the_scratch_dir_is_named_under_the_sessions_own_section(self) -> None:
        text = prompt_builder.session_prompt(self.record)
        scratch = f'"$HERMES_SAFE_ROOT/.scratch/{self.record["branch"]}"'
        self.assertIn(scratch, text)
        self.assertIn("**library_add**", text, "the rule that files them is told too")
        self.assertLess(
            text.index("**library_add**"),
            text.index(scratch),
            "the rule stands above the section that names where the session works",
        )
        self.assertNotIn(
            self.record["branch"],
            text.split("## Current Session")[0],
            "no branch above the section that names this session",
        )

    def test_the_line_teaches_the_naming_convention(self) -> None:
        text = prompt_builder.session_prompt(self.record)
        # Folders are named after the flow, kebab-case, and file names too.
        self.assertIn("library-tab-tree-view", text)
        self.assertIn("kebab-case", text)
        self.assertIn("dashboard-light.png", text)

    def test_the_scratch_line_is_told_whether_or_not_a_folder_is_set(self) -> None:
        # The library folder is the tool's business, so nothing in the prompt depends on it: a record
        # from before library folders is told the same rules and the same scratch directory.
        legacy = {**self.record, "files_dir": None}
        self.assertEqual(
            prompt_builder.session_prompt(legacy), prompt_builder.session_prompt(self.record)
        )

    def test_the_gots_section_tells_its_rules_before_any_session_fact(self) -> None:
        # The Gots section is the same for every session, so its rules are told together and above
        # the section that names this one, which is what makes the opening shared (ADR 0028).
        text = prompt_builder.session_prompt(self.record)
        self.assertIn("Keep the todo list current", text, "the guidelines are told together")
        self.assertLess(text.index("## Do"), text.index("## Don't"))
        self.assertLess(text.index("## Don't"), text.index("## Tools"))
        self.assertLess(text.index("**library_add**"), text.index("**pull_request**"))
        self.assertLess(text.index("**pull_request**"), text.index("## Current Session"))

    def test_the_block_names_the_rhythm_rules(self) -> None:
        text = prompt_builder.session_prompt(self.record)
        self.assertIn("short update between checkpoints", text)
        self.assertIn("Keep the todo list current", text)
        self.assertIn("before you commit it", text, "the diff is read before it goes in")
        self.assertIn("Don't narrate each edit", text)

    def test_the_media_block_says_how_a_file_is_named_and_where_it_may_come_from(self) -> None:
        # The tag is a message's own convention, so it is told beside the tools rather than in one of
        # them: a session can name a file it filed in an earlier run.
        text = prompt_builder.session_prompt(self.record)
        self.assertIn("## Media", text)
        self.assertIn("`MEDIA:`", text, "the marker is told literally")
        self.assertIn("library file", text, "and the only place a file may come from")
        media = text.split("## Media")[1]
        self.assertIn("absolute path", media, "the path starts at the filesystem root")
        self.assertIn("never a path relative to the folder you are in", media)
        self.assertIn("Never a scratch, worktree or other temporary path", media)
        self.assertIn("caches what it fetches", media, "the reason: a temp path draws a stale copy")
        self.assertIn("is a row the user saves", media, "a file that is not drawn is still handed over")

    def test_a_record_without_worktrees_has_no_block(self) -> None:
        # The same gate as the ship instructions: a record with no repos gets neither.
        no_repos = {**self.record, "repos": []}
        text = prompt_builder.session_prompt(no_repos)
        self.assertNotIn("Keep the todo list current", text)
        self.assertNotIn("**pull_request**", text)

    def test_the_mock_repeats_the_instructions_word_for_word(self) -> None:
        # The mock is a standalone Node process, so its copy can't be imported; the e2e flows read
        # the text it serves, so a drift there tests a prompt no session gets. Compared the way
        # test_push_kinds compares its lists to the app's. Only the blocks meant to be verbatim:
        # the plan is a template, and the wording inside it is Hermes's own.
        import json
        import re

        app = Path(__file__).resolve().parents[2] / "app"
        mock_js = (app / "scripts" / "mock-hermes.mjs").read_text()
        for name, block in (
            ("GOTS_OPENING", prompt_builder._GOTS_OPENING),
            ("DO_RULES", prompt_builder._DO_RULES),
            ("DONT_RULES", prompt_builder._DONT_RULES),
            ("LIBRARY_RULES", prompt_builder._LIBRARY_RULES),
            ("PR_INSTRUCTIONS", prompt_builder._PR_RULES),
            ("MEDIA_RULES", prompt_builder._MEDIA_RULES),
        ):
            with self.subTest(block=name):
                found = re.search(rf'^\s*const {name} = "(.*)"$', mock_js, re.M)
                if found is None:
                    self.fail(f"{name} is not in the mock")
                self.assertEqual(json.loads(f'"{found.group(1)}"'), block)


if __name__ == "__main__":
    unittest.main()
