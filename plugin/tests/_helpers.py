"""Shared test helpers for plugin tests."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, Iterable, List, Optional, Sequence
from unittest.mock import MagicMock, patch

from plugin import dictation_cleanup, pipeline, workflows
from plugin.tasks import READY_LABEL


class FakeLlm:
    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.calls: List[Dict[str, Any]] = []

    def complete_structured(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return SimpleNamespace(parsed=answer)


def with_model(*answers: Any):
    llm = FakeLlm(*answers)
    return llm, patch.object(dictation_cleanup, "ctx", SimpleNamespace(llm=llm))


class FakeWeb:
    """The little of ``aiohttp.web`` the plugin's wiring touches, answering what it was given."""

    class Response:
        pass

    class StreamResponse:
        pass

    class Request:
        pass

    @staticmethod
    def json_response(payload: Any, status: int = 200) -> Dict[str, Any]:
        return {"status": status, "payload": payload}


class Router:
    """An app's router, recording every route the plugin added."""

    def __init__(self) -> None:
        self.added: List[tuple] = []

    def add_get(self, path: str, handler: Any) -> None:
        self.added.append(("GET", path, handler))

    def add_post(self, path: str, handler: Any) -> None:
        self.added.append(("POST", path, handler))

    def add_delete(self, path: str, handler: Any) -> None:
        self.added.append(("DELETE", path, handler))

    def add_route(self, method: str, path: str, handler: Any) -> None:
        self.added.append((method, path, handler))

    def routes(self) -> List[Any]:
        return []


class App:
    """The API server's app, as far as the plugin's wiring reaches into it."""

    def __init__(self) -> None:
        self.router = Router()
        self.cleanup_ctx: List[Any] = []


class Context:
    """What Hermes hands ``register``, recording what the plugin wired."""

    def __init__(self) -> None:
        self.platforms: Dict[str, Any] = {}
        # name -> the callbacks in the order the plugin registered them, since that order is what
        # Hermes resolves a pre-tool block by (the first block wins).
        self.hooks: Dict[str, list] = {}

    def register_hook(self, name: str, callback: Any) -> None:
        self.hooks.setdefault(name, []).append(callback)

    def register_tool(self, **kwargs: Any) -> None:
        pass

    def register_cli_command(self, **kwargs: Any) -> None:
        pass

    def register_skill(self, *args: Any, **kwargs: Any) -> None:
        pass

    def register_platform_handler(self, name: str, handler: Any) -> None:
        self.platforms[name] = handler


def staged(
    kind: str = pipeline.BUILD,
    *,
    build: Optional[str] = "plan",
    steps: Sequence[str] = ("code-review",),
    gate: Optional[Dict[str, Any]] = None,
    stop: Optional[str] = None,
) -> Dict[str, Any]:
    """A task's snapshot at one step of a staged workflow, as the tools and prompts read one.

    The step is named the way the host judges it — ``build``, ``gate``, ``critique`` or ``done`` —
    and the workflow is the shape a project's old skill columns described, so a test states the
    skills it means and nothing else about the workflow.
    """
    record = pipeline.start(
        {
            "id": "wf-test",
            "name": "Build · Test · Review · Summary",
            "stages": workflows.from_skills(build, steps),
        }
    )
    found = len(record["stages"])
    for candidate in range(len(record["stages"]) + 1):
        if pipeline.kind({**record, "stage": candidate}) == kind:
            found = candidate
            break
    record["stage"] = found
    for index, entry in enumerate(record["stages"]):
        entry["state"] = (
            pipeline.FINISHED
            if index < found
            else pipeline.CURRENT
            if index == found
            else pipeline.TODO
        )
        entry["rounds"] = [pipeline.new_round()] if index <= found else []
    if found < len(record["stages"]):
        current = record["stages"][found]["rounds"][-1]
        if gate is not None:
            current["gate"] = gate
        if stop is not None:
            current["stop"] = stop
            record["stages"][found]["state"] = pipeline.FAILED
    return record


def preset(workflow_id: str = workflows.DEFAULT_ID) -> Dict[str, Any]:
    """A preset as the library seeds it, in the shape ``pipeline.start`` snapshots.

    Read from the plugin's own presets rather than copied into a test, so a preset whose body moves
    is tested as it ships.
    """
    for found, name, stages in workflows.PRESETS:
        if found == workflow_id:
            return {"id": found, "name": name, "stages": stages}
    raise KeyError(f"no preset {workflow_id}")


def placed(
    workflow: Dict[str, Any],
    index: int = 0,
    gate: Optional[Dict[str, Any]] = None,
    stop: Optional[str] = None,
) -> Dict[str, Any]:
    """A task's snapshot of ``workflow``, in the stage at ``index``, as the engine leaves it.

    Every stage before it has finished and it is the one in hand — what a task looks like once the
    runs before this stage have ended, which is where a test of one stage's end starts. ``gate`` is
    the answer the stage's round carries and ``stop`` why it stalled.
    """
    record = pipeline.start(workflow)
    record["stage"] = index
    for at, entry in enumerate(record["stages"]):
        entry["state"] = (
            pipeline.FINISHED
            if at < index
            else pipeline.CURRENT
            if at == index
            else pipeline.TODO
        )
        entry["rounds"] = [pipeline.new_round()] if at <= index else []
    if index < len(record["stages"]):
        current = record["stages"][index]["rounds"][-1]
        if gate is not None:
            current["gate"] = gate
        if stop is not None:
            current["stop"] = stop
            record["stages"][index]["state"] = pipeline.FAILED
    return record


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


def usage_window(
    label: str, used: float, resets: Optional[str] = None, scope: Optional[str] = None
) -> Dict[str, Any]:
    """A usage window as ``usage.serialize`` writes it onto the wire.

    ``resets`` is its reset time as ISO, or None for a balance; ``scope`` is what the account marked
    it with. Spelled once, so a field ``serialize`` gains is one edit here rather than one per suite.
    """
    return {
        "label": label,
        "used_percent": used,
        "resets_at": resets,
        "detail": None,
        "scope": scope,
    }


def issue_row(
    number: int,
    *,
    title: Optional[str] = None,
    created: str = "2026-10-01T00:00:00Z",
    state: str = "open",
    body: Optional[str] = "",
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
