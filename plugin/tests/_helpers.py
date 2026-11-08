"""Shared test helpers for plugin tests."""

from __future__ import annotations

import contextvars
import json
import re
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, Iterable, Iterator, List, Optional
from unittest.mock import MagicMock, patch

import plugin
from plugin import dictation_cleanup
from plugin.tasks import READY_LABEL

# Stands in for the host's own profile scope: `HERMES_HOME_OVERRIDE` and the secret scope are context
# variables a request sets and `copy_context()` carries. Read by a fake decode the way Hermes reads
# its own, so a test can prove the work ran as the bot it was done for.
BOT = contextvars.ContextVar("gots-test-bot", default="the launch profile")


@contextmanager
def bot_scope(value: str = "bot-a") -> Iterator[None]:
    """Enter one bot's scope, the way a request's thread has it, and take it back after."""
    token = BOT.set(value)
    try:
        yield
    finally:
        BOT.reset(token)


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
        """A response carrying bytes and their headers, as a route that serves a file answers one."""

        def __init__(self, *, body: Any = None, headers: Optional[Dict[str, Any]] = None,
                     status: int = 200, **extra: Any) -> None:
            self.body = body
            self.headers = dict(headers or {})
            self.status = status
            self.extra = extra

    class StreamResponse:
        pass

    class HTTPRequestEntityTooLarge(Exception):
        """The request body passed the server's own cap, which a route answers in its own words."""

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


class RouteAdapter:
    """The API server as far as a wired route reaches: its auth check, and nothing else."""

    def __init__(self) -> None:
        self.denied: Any = None

    def _check_auth(self, request: Any) -> Any:
        return self.denied


def wire(case: unittest.TestCase, adapter: Any) -> Any:
    """The plugin's routes on a fake app, wired the way the API server wires them.

    The ``aiohttp`` stand-in and the module-level adapters the wiring leaves behind are registered
    for cleanup with the case.
    """
    aiohttp = ModuleType("aiohttp")
    aiohttp.web = FakeWeb()
    wiring = patch.dict(sys.modules, {"aiohttp": aiohttp, "aiohttp.web": aiohttp.web})
    wiring.start()
    case.addCleanup(wiring.stop)
    for module in (plugin.sessions, plugin.approvals):
        held = getattr(module, "adapter", None)
        case.addCleanup(setattr, module, "adapter", held)
    app = App()
    context = Context()
    plugin.register(context)
    context.platforms["api_server"](app, adapter)
    return app


def route(app: Any, path: str, method: Optional[str] = None) -> Any:
    """A handler the plugin registered on a wired app, or a failure naming the missing path.

    A path that carries both a read and a write is told apart by ``method``.
    """
    for registered_method, registered, handler in app.router.added:
        if registered == path and method in (None, registered_method):
            return handler
    raise AssertionError(f"the plugin registered no {path}")


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


def probe_record(
    models: Dict[str, float],
    *,
    host: Optional[Dict[str, Any]] = None,
    sha: Optional[str] = None,
    decode_ms: int = 700,
) -> Dict[str, Any]:
    """A stored speech measurement as ``speech_probe.measure`` writes one.

    ``models`` is what a test means — ``{model: realtime}``; the rest is the record around it, with
    this machine's own identity and the committed recording's digest unless the test names others.
    One builder, so a field the record gains lands once rather than in every suite that plants one.
    """
    from plugin import speech_probe

    return {
        "object": speech_probe.OBJECT,
        "at": "2026-11-02T10:00:00Z",
        "host": speech_probe.machine() if host is None else host,
        "fixture": {
            "bytes": 95300,
            "sha256": speech_probe.digest() if sha is None else sha,
            "ms": speech_probe.spoken_ms(),
        },
        "models": {
            name: {"realtime": realtime, "decode_ms": decode_ms, "load_ms": 900, "at": "2026-11-02T10:00:00Z"}
            for name, realtime in models.items()
        },
    }


def js_constant(source: str, name: str) -> str:
    """``name``'s value from a JavaScript or TypeScript source: its string literals, joined.

    The mock and the app's fixtures repeat a plugin's own words verbatim and are held to them from
    Python, so this is how one is read back. A constant may be one literal or several joined with
    ``+``, and each is unescaped the way the engine would.
    """
    literal = r'"(?:[^"\\]|\\.)*"'
    found = re.search(rf"const {re.escape(name)} =\s*((?:{literal}\s*\+\s*)*{literal})", source)
    if found is None:
        raise AssertionError(f"no string constant {name} in the source")
    return "".join(json.loads(piece) for piece in re.findall(literal, found.group(1)))


def js_number(source: str, name: str) -> float:
    """``name``'s value from a JavaScript or TypeScript source: a number literal, as a float.

    ``js_constant`` reads a string; a figure a fake restates — a threshold, a budget — is a number,
    and the copy is worth holding to the producer the same way.
    """
    found = re.search(rf"const {re.escape(name)} = (-?[0-9]+(?:\.[0-9]+)?)\b", source)
    if found is None:
        raise AssertionError(f"no number constant {name} in the source")
    return float(found.group(1))


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
        "html_url": f"https://github.com/mock-user/gots/issues/{number}",
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
        row["pull_request"] = {"url": "https://api.github.com/repos/mock-user/gots/pulls/1"}
    return row
