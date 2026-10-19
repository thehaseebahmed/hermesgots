"""Shared test helpers for plugin tests."""

import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, Iterable, Optional
from unittest.mock import MagicMock, patch

from plugin.tasks import READY_LABEL


def make_fake_agent(lookup_fn, scope_already=None):
    """Inject fake agent.credential_pool and agent.secret_scope modules.

    ``lookup_fn`` is the fake get_env_prefer_dotenv.
    ``scope_already`` — when not None — simulates an already-active scope
    by making current_secret_scope return it, so token() should NOT
    build a new one.

    Returns a patch.dict context manager for sys.modules.
    """
    fake_agent = ModuleType("agent")

    fake_pool = ModuleType("agent.credential_pool")
    fake_pool.get_env_prefer_dotenv = lookup_fn
    fake_agent.credential_pool = fake_pool

    fake_scope = ModuleType("agent.secret_scope")
    fake_scope.current_secret_scope = MagicMock(return_value=scope_already)
    fake_scope.build_profile_secret_scope = MagicMock(return_value={})
    fake_scope.set_secret_scope = MagicMock(return_value="fake_scope_token")
    fake_scope.reset_secret_scope = MagicMock()
    fake_agent.secret_scope = fake_scope

    return patch.dict(
        "sys.modules",
        {
            "agent": fake_agent,
            "agent.credential_pool": fake_pool,
            "agent.secret_scope": fake_scope,
        },
    )


class _FakeProjectsContext:
    """Stands in for projects_db.connect_closing's context manager."""

    def __enter__(self) -> "_FakeProjectsContext":
        return self

    def __exit__(self, *args: object) -> bool:
        return False


def stub_projects_db(projects=None, get_project=None, list_projects=None):
    """Stands in for hermes_cli.projects_db, which only exists on a Hermes host.

    ``projects`` is what ``list_projects`` returns; ``get_project`` and ``list_projects``
    override those calls. Returns a ``patch.dict`` for ``sys.modules``.
    """
    module = ModuleType("hermes_cli")
    projects_db = ModuleType("hermes_cli.projects_db")
    projects_db.connect_closing = lambda db_path: _FakeProjectsContext()
    projects_db.list_projects = list_projects or (
        lambda conn, include_archived=False: list(projects or [])
    )
    if get_project is not None:
        projects_db.get_project = get_project
    module.projects_db = projects_db
    return patch.dict(sys.modules, {"hermes_cli": module, "hermes_cli.projects_db": projects_db})


def temp_hermes_home(case: unittest.TestCase) -> Path:
    """Give ``case`` a throwaway Hermes home that ``hermes_constants.get_hermes_home`` answers.

    The temp directory and the patch are cleaned up with the case. Returns the home as a Path;
    the host hands the plugin a string, which is what the fake answers.
    """
    tmp = tempfile.TemporaryDirectory()
    case.addCleanup(tmp.cleanup)
    home = Path(tmp.name)
    constants = ModuleType("hermes_constants")
    constants.get_hermes_home = lambda: str(home)  # type: ignore[attr-defined]
    patcher = patch.dict(sys.modules, {"hermes_constants": constants})
    patcher.start()
    case.addCleanup(patcher.stop)
    return home

def issue_row(
    number: int,
    *,
    title: Optional[str] = None,
    created: str = "2026-10-01T00:00:00Z",
    state: str = "open",
    body: str = "",
    labels: Iterable[str] = (READY_LABEL,),
    assignees: Iterable[str] = (),
    summary: Optional[int] = 0,
    open_edges: Optional[int] = None,
    pull_request: bool = False,
) -> Dict[str, Any]:
    """An issue as GitHub's list answers it, ready-marked unless the test says otherwise.

    ``summary`` is the count GitHub gives ``issue_dependencies_summary`` (``None``: no key at all,
    the shape of an issue with no native dependency to report), and ``open_edges`` how many of them
    are still open; all of them open unless the test says otherwise.
    """
    row: Dict[str, Any] = {
        "number": number,
        "title": title or f"Task {number}",
        "html_url": f"https://github.com/mock-user/memento/issues/{number}",
        "state": state,
        "created_at": created,
        "body": body,
        "labels": [{"name": name} for name in labels],
        "assignees": [{"login": login} for login in assignees],
    }
    if summary is not None:
        row["issue_dependencies_summary"] = {
            "total_blocked_by": summary,
            "blocked_by": summary if open_edges is None else open_edges,
        }
    if pull_request:
        row["pull_request"] = {"url": "https://api.github.com/repos/mock-user/memento/pulls/1"}
    return row
