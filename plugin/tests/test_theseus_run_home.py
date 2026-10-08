"""Finding a Theseus session's run wherever the agent started it.

Run: python3 -m unittest plugin.tests.test_theseus_run_home -v
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from plugin import theseus


def make_run(folder: Path, **run: object) -> None:
    current = folder / ".theseus" / "current"
    current.mkdir(parents=True)
    (current / "run.json").write_text(json.dumps({"key": "k", "planRequired": True, **run}))
    (current / "checkpoints.json").write_text(json.dumps({"checkpoints": []}))


class RunHomeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.tree = self.root / "repo" / ".worktrees" / "slug"
        self.tree.mkdir(parents=True)
        self.record = {"path": str(self.tree), "repos": [{"path": str(self.tree)}]}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_falls_back_to_the_worktree(self) -> None:
        self.assertEqual(theseus.run_home(self.record), str(self.tree))

    def test_finds_the_run_at_the_top(self) -> None:
        make_run(self.tree)
        self.assertEqual(theseus.run_home(self.record), str(self.tree))

    def test_finds_a_run_started_in_a_subfolder(self) -> None:
        make_run(self.tree / "app")
        self.assertEqual(theseus.run_home(self.record), str(self.tree / "app"))
        self.assertEqual(theseus.stage(theseus.light(theseus.run_home(self.record))), "discovery")

    def test_skips_dependencies(self) -> None:
        make_run(self.tree / "node_modules" / "pkg")
        self.assertEqual(theseus.run_home(self.record), str(self.tree))

    def test_newest_run_wins(self) -> None:
        make_run(self.tree / "a")
        make_run(self.tree / "b")
        old = time.time() - 60
        os.utime(self.tree / "a" / ".theseus" / "current" / "run.json", (old, old))
        self.assertEqual(theseus.run_home(self.record), str(self.tree / "b"))

    def test_finds_a_multi_repo_run_above_that_lists_the_worktree(self) -> None:
        above = self.root / "repo"
        make_run(above, repos=[{"name": "repo", "path": ".worktrees/slug"}])
        self.assertEqual(theseus.run_home(self.record), str(above))

    def test_ignores_an_unrelated_run_above(self) -> None:
        make_run(self.root / "repo", repos=[{"name": "other", "path": "elsewhere"}])
        self.assertEqual(theseus.run_home(self.record), str(self.tree))


if __name__ == "__main__":
    unittest.main()
