"""Plan mode blocks the tools that would change the worktree: the hook's answer per call.

Run: python3 -m unittest plugin.tests.test_plan_mode -v

"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from plugin import sessions
from plugin.store import db_path
from plugin.tests._helpers import stub_projects_db

# A plan-mode reply as the agent writes it: the heading is what makes it a plan.
PLAN_REPLY = "# Plan: rotate the logs\n\n1. Add a dry run to the rotation.\n"


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


class PlanOwnershipTest(unittest.TestCase):
    """A plan-mode reply belongs to the session it ran in: no other row may take it.

    Two sessions of one project both hold a worktree of their own, so the session a plan is filed
    under is the session whose card shows it — and whose file its approval runs.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db = db_path(self.home)
        self.project = SimpleNamespace(
            id="p1",
            name="web",
            archived=False,
            folders=[SimpleNamespace(path=str(self.home / "project"), is_primary=True)],
        )
        (self.home / "project").mkdir(parents=True, exist_ok=True)
        # save_plan resolves the project's folder, so projects.db exists and is stubbed.
        (self.home / "projects.db").write_bytes(b"")
        fake = types.ModuleType("hermes_constants")
        fake.get_hermes_home = lambda: str(self.home)  # type: ignore[attr-defined]
        home_patcher = mock.patch.dict(sys.modules, {"hermes_constants": fake})
        home_patcher.start()
        self.addCleanup(home_patcher.stop)
        projects = stub_projects_db([self.project])
        projects.start()
        self.addCleanup(projects.stop)
        self.addCleanup(self.tmp.cleanup)

    def _session(self, session_id: str, mode: str = "plan") -> None:
        repos = [
            {
                "name": "o/web",
                "repo_root": str(self.home / "project"),
                "path": str(self.home / "project" / ".worktrees" / session_id),
                "branch": f"hermes/{session_id}",
            }
        ]
        sessions._upsert(self.db, session_id, "p1", repos, mode, None)

    def _lineage(self, pairs: list[tuple[str, str | None]]) -> None:
        """Hermes's own store, with the parent links compression leaves behind."""
        with sqlite3.connect(self.home / "state.db") as conn:
            conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT)")
            conn.executemany("INSERT INTO sessions (id, parent_session_id) VALUES (?, ?)", pairs)

    def test_a_plan_lands_on_its_own_session_only(self) -> None:
        self._session("memento-a")
        self._session("memento-b", mode="accept_edits")
        sessions.after_llm(
            session_id="memento-a", task_id="memento-a", assistant_response=PLAN_REPLY
        )
        sessions.after_run(session_id="memento-a", completed=True, interrupted=False)
        first = sessions.read(self.db, "memento-a")
        other = sessions.read(self.db, "memento-b")
        assert first is not None and other is not None
        self.assertTrue(first["plan_pending"])
        self.assertTrue(str(first["plan_file"]).startswith("plans/"))
        # The other session of the same project keeps its own row: no plan, no file, its own mode.
        self.assertFalse(other["plan_pending"])
        self.assertIsNone(other["plan_file"])
        self.assertEqual(other["mode"], "accept_edits")

    def test_an_ancestors_record_is_never_this_sessions_workspace(self) -> None:
        # A chat Hermes moved to a child session: the child has no record, its lineage reaches A's.
        self._session("memento-a")
        mine = sessions.read(self.db, "memento-a")
        assert mine is not None
        self.assertTrue(sessions.save_plan(self.db, self.home, mine, PLAN_REPLY))
        sessions.set_plan_pending(self.db, "memento-a", True)
        self._lineage([("memento-a", None), ("memento-child", "memento-a")])
        # The walk is what the hooks need: a child's tool call finds the worktree its chat runs in.
        # It finds A's pending plan and file with it, which is why the route the app reads — the one
        # whose plan card approves that file — must not use it.
        ancestor = sessions.record_for(self.db, self.home, "memento-child")
        assert ancestor is not None
        self.assertEqual(ancestor["session_id"], "memento-a")
        self.assertTrue(ancestor["plan_pending"])
        self.assertTrue(str(ancestor["plan_file"]).startswith("plans/"))
        # What the app reads is the session's own: none of that is the child's workspace.
        self.assertIsNone(sessions.record_of(self.db, "memento-child"))
        own = sessions.record_of(self.db, "memento-a")
        assert own is not None
        self.assertEqual(own["session_id"], "memento-a")
