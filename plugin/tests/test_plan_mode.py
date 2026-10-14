"""Plan mode blocks the tools that would change the worktree: the hook's answer per call.

Run: python3 -m unittest plugin.tests.test_plan_mode -v

"""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import sessions
from plugin.store import db_path


class PlanModeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db = db_path(self.home)
        fake = types.ModuleType("hermes_constants")
        fake.get_hermes_home = lambda: str(self.home)  # type: ignore[attr-defined]
        patcher = mock.patch.dict(sys.modules, {"hermes_constants": fake})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def _before_tool(self, tool: str, mode: str):
        repos = [
            {
                "name": "o/web",
                "repo_root": str(self.home / "project"),
                "path": str(self.home / "project" / ".worktrees" / "jazzy-quokka-7bfe"),
                "branch": "hermes/jazzy-quokka-7bfe",
            }
        ]
        sessions._upsert(self.db, "memento-1", "p1", repos, mode, None)
        return sessions._before_tool(
            {
                "tool_name": tool,
                "args": {"path": "shot.png"},
                "task_id": "memento-1",
                "session_id": "memento-1",
            }
        )

    def test_a_mutating_tool_is_blocked(self) -> None:
        # library_add moves a file out of the worktree, so plan mode blocks it like the rest.
        self.assertEqual(
            self._before_tool("library_add", "plan"),
            {"action": "block", "message": sessions.PLAN_BLOCK},
        )

    def test_a_read_only_tool_is_left_alone(self) -> None:
        self.assertIsNone(self._before_tool("read_file", "plan"))

    def test_outside_plan_mode_nothing_is_blocked(self) -> None:
        self.assertIsNone(self._before_tool("library_add", "accept_edits"))
