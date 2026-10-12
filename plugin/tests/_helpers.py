"""Shared test helpers for plugin tests."""

import sys
from types import ModuleType
from unittest.mock import MagicMock, patch


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