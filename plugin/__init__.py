"""Gots's Hermes plugin.

Adds routes to the API server, so the Gots app (which only talks to the API server, with its key)
can read cron run history from Hermes's execution ledger instead of piecing it together on each
device, keep its chat list on the server (``chats.py``), report each chat's context use
(``context.py``) and the agent's todo list (``todos.py``), list and create Hermes Projects (``projects.py``) with GitHub repos cloned into
them in the background (``clones.py``, ``github.py``), add and remove a project's repos (``repos.py``), run project sessions in their own worktrees with a permission mode and save their plans
(``sessions.py``), let the agent push and open its pull requests, close them when a session is dropped (``ship.py``), file the files it generates in the project's library (``library.py``) and resolve a session once its pull request merges (``merges.py``), hold a chat's goal with Hermes's own ``/goal`` and keep it going between runs (``goal.py``), research a question into a cited guide, quiz or glossary (``research.py``), let the agent ask the user questions with Hermes's ``clarify`` tool (``clarify.py``), keep its delegations in the turn that made them (``delegation.py``) and
set the profile's main model from a bot's Default model (``host_model.py``), label its chats as Gots's, tell the app what changed as it happens (``events.py``, ``stream.py``), and links the profile to a Gots account (``link.py``). The dashboard half lives in ``dashboard/``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import (
    afk,
    alerts,
    approvals,
    attachments,
    chats,
    clarify,
    cleanup,
    clones,
    community,
    context,
    delegation,
    dictation,
    events,
    github,
    goal,
    host_model,
    library,
    link,
    mcp,
    media,
    model_changes,
    merges,
    outbox,
    projects,
    prompt_builder,
    repos,
    research,
    sessions,
    skill_catalog,
    push,
    ship,
    stream,
    tasks,
    todos,
    usage,
)
from .store import db_path

logger = logging.getLogger(__name__)

PREFIX = "/api/plugins/memento"
# Gots shows 24 runs per job.
DEFAULT_PER_JOB = 24
MAX_PER_JOB = 200


def _version() -> str:
    try:
        text = (Path(__file__).parent / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return "0.0.0"
    match = re.search(r"^version:\s*[\"']?([^\"'\s]+)", text, re.M)
    return match.group(1) if match else "0.0.0"


VERSION = _version()

RUN_FIELDS = (
    "id",
    "job_id",
    "source",
    "status",
    "claimed_at",
    "started_at",
    "finished_at",
    "error",
    "delivery_outcome",
)


def _runs_by_job(job_id: str | None, per_job: int) -> Dict[str, List[Dict[str, Any]]]:
    from cron.executions import list_executions

    if job_id:
        job_ids = [job_id]
    else:
        from cron.jobs import list_jobs

        job_ids = [job["id"] for job in list_jobs(include_disabled=True) if job.get("id")]
    return {
        jid: [
            {field: row.get(field) for field in RUN_FIELDS}
            for row in list_executions(job_id=jid, limit=per_job)
        ]
        for jid in job_ids
    }


def _error(web: Any, message: str, status: int):
    # The API server's own error shape, so clients read every error the same way.
    return web.json_response({"error": {"message": message}}, status=status)


def mirror_for_profiles(app: Any, web: Any) -> None:
    """Serve every route again at ``PREFIX/p/{profile}/...`` for bots at ``/p/<profile>``.

    Hermes registers a catch-all for ``/p/{profile}/...`` before plugin routes, so the natural
    ``/p/<profile>/api/plugins/...`` can't be reached. A path with ``{profile}`` inside the plugin's
    own prefix still gets Hermes's prefix middleware: it validates the profile, scopes the home
    and credentials, and ``_check_auth`` then takes that profile's own key.
    """
    try:
        from gateway.platforms.api_server import _api_request_profile
    except ImportError:
        logger.warning("memento: this Hermes can't scope routes by profile; /p/<profile> bots stay off")
        return

    def scoped(handler: Any):
        async def run(request: "web.Request"):
            # A single-profile gateway resolves any prefix to None, so only a request the middleware
            # really scoped to the named profile may reach the handler.
            if _api_request_profile.get() != request.match_info.get("profile"):
                return _error(web, "Unknown or unconfigured profile", 404)
            return await handler(request)

        return run

    for route in list(app.router.routes()):
        path = route.resource.canonical if route.resource else ""
        if route.method == "HEAD" or not path.startswith(PREFIX + "/"):
            continue
        app.router.add_route(
            route.method, f"{PREFIX}/p/{{profile}}{path[len(PREFIX):]}", scoped(route.handler)
        )


def _wire_api_server(app: Any, adapter: Any) -> None:
    from aiohttp import web

    # The hooks have no other way to the session store.
    sessions.adapter = adapter
    # Approvals that end without an answer leave the run looking stuck; see approvals.py.
    approvals.adapter = adapter
    # The API server's agents can't ask questions on their own; see clarify.py.
    asks = clarify.wire(adapter)
    # Hermes defers todo_list behind tool_search, where the agent can't always find it; see todos.py.
    todo_tool = todos.wire(adapter)
    # The agent ships its own work; see ship.py.
    ship.wire(adapter)
    # The agent files its generated files in the project's library; see library.py.
    library.wire(adapter)
    # A background delegation's result would wait for the user's next message; see delegation.py.
    delegation.wire(adapter)
    # Research missions' researchers record their claims; see research.py.
    research.wire(adapter)

    async def daily_cleanup(_app: Any):
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
        approvals.loop = asyncio.get_running_loop()
        try:
            # A restart can leave projects mid-clone.
            await asyncio.to_thread(clones.resume, home)
            await asyncio.to_thread(repos.resume, home)
        except Exception:
            logger.debug("memento: couldn't resume project clones", exc_info=True)
        tasks = [
            asyncio.ensure_future(cleanup.run_daily(adapter, home)),
            # Linked profiles keep their bot record current in the Gots registry; see link.py.
            asyncio.ensure_future(link.run(adapter)),
            asyncio.ensure_future(merges.run(home)),
            # Queued messages start their turn once the session's run is over; see outbox.py.
            asyncio.ensure_future(outbox.run(adapter, home)),
            asyncio.ensure_future(alerts.run(home)),
            # Research missions write up once their researcher stops; see research.py.
            asyncio.ensure_future(research.run(home)),
            # Projects left to work their own tasks are swept for work while the host runs; see
            # afk.py. A sweep is woken when one is turned on and when a session finishes.
            asyncio.ensure_future(afk.run(adapter)),
        ]
        yield
        for task in tasks:
            task.cancel()

    try:
        app.cleanup_ctx.append(daily_cleanup)
    except RuntimeError:
        logger.warning("memento: the API server already started; no daily cleanup until restart")

    def unauthorized(request: "web.Request"):
        # The API server's own Bearer check, so the routes take the same key as /v1. Fail closed if
        # a Hermes update renames it.
        check = getattr(adapter, "_check_auth", None)
        if not callable(check):
            return _error(web, "Unauthorized", 401)
        return check(request)

    def hooks_live() -> bool:
        # The routes of a /p/<profile> bot are served by the default profile's copy of the plugin,
        # but the hooks (context, todos, labels, plans) run only where the profile loaded it too.
        try:
            from hermes_cli.plugins import get_plugin_manager

            loaded = getattr(get_plugin_manager(), "_plugins", {}).get("memento")
            return bool(loaded and loaded.enabled and not loaded.error)
        except Exception:
            return True

    def owned_runs(request: "web.Request"):
        # _run_statuses belongs to the one adapter every profile shares; a run is owned by the
        # profile and key that started it. Fail open if a Hermes update renames the scope.
        owners = getattr(adapter, "_run_owners", None)
        scope = getattr(adapter, "_run_idempotency_scope", None)
        if not isinstance(owners, dict) or not callable(scope):
            return None
        try:
            mine = scope(request)
        except Exception:
            return None
        return lambda run_id: owners.get(run_id) == mine

    async def info(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        # The MCP screen is advertised only where Hermes's own MCP built-ins import, so a bot whose
        # Hermes is too old gets no row rather than an error; the switch, the removal, the Catalogue
        # and adding from it are advertised apart from it and from each other, because each needs a
        # different set of built-ins — a host that can list servers may still not be able to switch
        # one, one that can switch may predate the removal, one may have no Catalogue to add from,
        # and one may have a Catalogue it can only read — and must not offer a control that can't
        # work. Which built-ins each needs is mcp.py's table.
        # Off the loop: the checks import them.
        serves_mcps = await asyncio.to_thread(mcp.available) is None
        mcp_features = [
            name
            for name, gate in mcp.FEATURES
            if serves_mcps and await asyncio.to_thread(gate) is None
        ]
        return web.json_response(
            {
                "name": "memento",
                "version": VERSION,
                "features": [
                    "cron_runs",
                    "session_label",
                    "chats",
                    "draft_text",
                    "context",
                    "todos",
                    "projects",
                    "projects_async",
                    "skills",
                    "project_repos",
                    "project_usage",
                    "github",
                    "sessions",
                    "runs",
                    "prs",
                    "plans",
                    "library",
                    # A project's ready tasks, read from its repositories' GitHub issues; see tasks.py.
                    "afk",
                    # Whether that project is left to work them: AFK's switch, the project's own
                    # setting on the host (afk.py). Advertised apart from the read, so a plugin that
                    # can list a project's tasks but never switch AFK on offers no switch at all.
                    "afk_switch",
                    "clarify",
                    "todo_tool",
                    "agents",
                    "attachments",
                    "media",
                    "profile_routes",
                    "pr_tool",
                    "close",
                    "merge_resolve",
                    "events",
                    "goal",
                    "push",
                    "sync_delegation",
                    "host_model",
                    "fallbacks",
                    "queue",
                    "dictation",
                    "usage",
                    "research",
                    "research_followup",
                    "research_rewrite",
                    "community",
                    # Hermes's own MCP built-ins, and the MCP screen with them; see mcp.py.
                    *mcp_features,
                ],
                "clarify": asks,
                "todo_tool": todo_tool,
                "hooks": hooks_live(),
                "goal": {
                    "ready": goal.available() is None,
                    "reason": goal.available(),
                    "min_turns": goal.MIN_TURNS,
                    "max_turns": goal.MAX_TURNS,
                },
                "dictation": await asyncio.to_thread(dictation.info),
                "research": {
                    "ready": research.available() is None,
                    "reason": research.available(),
                    # Whether the host lets a mission be written with another model than the profile's.
                    "writers": await asyncio.to_thread(research.llm_gate),
                },
            }
        )

    async def cron_runs(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            per_job = int(request.query.get("per_job", DEFAULT_PER_JOB))
        except ValueError:
            return _error(web, "per_job must be a number", 400)
        per_job = max(1, min(per_job, MAX_PER_JOB))
        job_id = request.query.get("job_id") or None
        try:
            jobs = await asyncio.to_thread(_runs_by_job, job_id, per_job)
        except ImportError:
            return _error(web, "This Hermes version has no cron execution ledger.", 501)
        return web.json_response({"object": "cron_runs", "jobs": jobs})

    async def label_session(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        db = await open_db() if callable(open_db) else None
        if db is None or not callable(getattr(db, "_execute_write", None)):
            return _error(web, "Session database unavailable", 503)
        # On the loop thread, like store_path: the profile scope isn't visible inside to_thread.
        code = sessions.is_code_session(session_id)
        source = await asyncio.to_thread(sessions.label, db, session_id, code)
        if not source:
            return _error(web, "Session not found", 404)
        return web.json_response({"id": session_id, "source": source})

    async def set_host_model(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            provider, model = host_model.clean(await json_body(request))
        except ValueError as error:
            return _error(web, str(error), 400)

        # Both on the loop thread, where the request's profile scope is visible: the worker
        # re-enters it, so switch_model reads this profile's credentials.
        config_path = host_config_path()
        scope = profile_scope()

        def run() -> Dict[str, str]:
            with scope():
                return host_model.set_main(config_path, provider, model)

        try:
            chosen = await asyncio.to_thread(run)
        except ValueError as error:
            return _error(web, str(error), 400)
        except ImportError:
            return _error(web, "This Hermes version can't switch models from here.", 501)
        return web.json_response({"object": "memento.host_model", **chosen})

    async def get_fallbacks(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        config_path = host_config_path()
        scope = profile_scope()

        def run() -> List[Dict[str, str]]:
            with scope():
                return host_model.read_fallbacks(config_path)

        try:
            fallbacks = await asyncio.to_thread(run)
        except ImportError:
            return _error(web, "This Hermes version can't read models from here.", 501)
        return web.json_response({"object": "memento.fallbacks", "fallbacks": fallbacks})

    async def list_skills(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        profile = request_profile()
        try:
            skills = await asyncio.to_thread(skill_catalog.read, profile)
        except ImportError:
            return _error(web, "This Hermes version can't list skills from here.", 501)
        return web.json_response({"object": "list", "data": skills})

    def mcp_route(
        call: Any,
        key: Optional[str],
        *,
        named: bool = True,
        unavailable: str = mcp.UNAVAILABLE,
        body: Optional[Any] = None,
    ) -> Any:
        """A route into Hermes's own MCP machinery: the guard, this bot's profile, one call, one key.

        Every MCP route has this shape — the signed-in check, the profile that makes the call land
        on this bot and no other, the 400 a body reader raises, the 501 for a host whose Hermes has
        moved the built-in the call needs, and the answer wrapped under one key (or spread, for a
        write that answers more than one thing) — so each declares only its call, its key and what
        it needs from the request. The call runs on the loop
        thread inside ``profile``'s scope, where the worker re-enters it; see mcp.py.
        """

        async def handler(request: "web.Request") -> "web.Response":
            denied = unauthorized(request)
            if denied is not None:
                return denied
            args: List[Any] = [request_profile()]
            if named:
                args.append(request.match_info["name"])
            if body is not None:
                try:
                    args.extend(body(await json_body(request)))
                except ValueError as error:
                    return _error(web, str(error), 400)
            try:
                answer = await asyncio.to_thread(call, *args)
            except mcp.McpError as error:
                return _error(web, str(error), error.status)
            except ImportError:
                return _error(web, unavailable, 501)
            return web.json_response({"object": answer if key is None else {key: answer}})

        return handler

    def install_body(body: Any) -> Any:
        """The entry's name and the values it declares, as the form that adds it sends them."""
        values = body.get("values") if body is not None else None
        if values is None:
            values = {}
        if (
            body is None
            or not isinstance(body.get("name"), str)
            or not body["name"]
            or not isinstance(values, dict)
            or not all(
                isinstance(key, str) and isinstance(value, str) for key, value in values.items()
            )
        ):
            raise ValueError('Body must be {"name": "<entry>", "values": {"NAME": "value"}}')
        return body["name"], values

    def custom_body(body: Any) -> Any:
        """A server the Catalogue doesn't offer, written the way an add from it is."""
        if body is None or not isinstance(body.get("name"), str) or not body["name"]:
            raise ValueError(
                'Body must be {"name": "<server>", "url": ... } or {..., "command": ...}'
            )
        return (body,)

    def server_body(body: Any) -> Any:
        """The block a save rewrites, whole: the transport, the arguments and the values."""
        if body is None:
            raise ValueError(
                'Body must describe the server\'s configuration: {"transport": ...}'
            )
        return (body,)

    def enabled_body(body: Any) -> Any:
        """The switch's new position, which is all a toggle says."""
        if body is None or not isinstance(body.get("enabled"), bool):
            raise ValueError('Body must be {"enabled": true} or {"enabled": false}')
        return (body["enabled"],)

    def access_body(body: Any) -> Any:
        """The address the browser ended on, pasted back from the phone that followed the flow."""
        if body is None or not isinstance(body.get("url"), str) or not body["url"]:
            raise ValueError('Body must be {"url": "<the address the browser ended on>"}')
        return (body["url"],)

    # The bot's servers and Hermes's Catalogue: what the tab's rows are built from. Neither connects
    # anything nor writes.
    list_mcp_servers = mcp_route(mcp.read, "servers", named=False)
    list_mcp_catalogue = mcp_route(mcp.catalogue, "entries", named=False)

    # One entry of the Catalogue with the values it declares: what the form that adds it is built
    # from. Nothing is written.
    get_mcp_catalogue_entry = mcp_route(mcp.entry, "entry")

    # An add runs Hermes's own catalogue machinery and config write — and its environment writer for
    # the values the entry declares secret — then its reconcile, so the server is live for this
    # bot's next turn and no other bot's config is touched.
    install_mcp_server = mcp_route(mcp.install, "servers", named=False, body=install_body)
    add_custom_mcp_server = mcp_route(mcp.custom, None, named=False, body=custom_body)

    # A toggle, a removal, a save and the Server access flow all write this bot's own config through
    # Hermes's writer and reconcile; a server a Hermes plugin provides is refused there.
    set_mcp_server_enabled = mcp_route(mcp.set_enabled, "server", body=enabled_body)
    remove_mcp_server = mcp_route(mcp.remove, "servers")
    save_mcp_server = mcp_route(mcp.edit, None, body=server_body)
    start_mcp_access = mcp_route(mcp.start_access, "access", unavailable=mcp.UNAVAILABLE_ACCESS)
    deliver_mcp_access = mcp_route(
        mcp.deliver_access,
        "access",
        unavailable=mcp.UNAVAILABLE_ACCESS,
        body=access_body,
    )

    # Config's block and Tools' cache: reads of what a registration wrote, connecting nothing, so
    # opening a server's sheet cannot spawn it. Only the probe reaches the server — one connect,
    # list and disconnect — which is why it is the tap's POST.
    get_mcp_server = mcp_route(mcp.detail, "server")
    read_mcp_tools = mcp_route(mcp.tools, "tools")
    probe_mcp_tools = mcp_route(mcp.probe_tools, "tools")

    async def set_fallbacks(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            entries = host_model.clean_fallbacks(await json_body(request))
        except ValueError as error:
            return _error(web, str(error), 400)

        # Both on the loop thread, where the request's profile scope is visible: the worker
        # re-enters it, so each pick is checked against this profile's credentials.
        config_path = host_config_path()
        scope = profile_scope()

        def run() -> List[Dict[str, str]]:
            with scope():
                return host_model.set_fallbacks(config_path, entries)

        try:
            fallbacks = await asyncio.to_thread(run)
        except ValueError as error:
            return _error(web, str(error), 400)
        except ImportError:
            return _error(web, "This Hermes version can't switch models from here.", 501)
        return web.json_response({"object": "memento.fallbacks", "fallbacks": fallbacks})

    def profile_scope():
        # The API server's own per-profile scope (home and secrets) for the request being served, or
        # nothing when this Hermes has none.
        enter = getattr(adapter, "_profile_scope", None)
        profile = request_profile()
        if not callable(enter):
            return contextlib.nullcontext
        return lambda: enter(profile)

    def host_config_path() -> Path:
        # On the loop thread, like store_path: the API server scopes get_hermes_home() to the
        # request's profile, and that scope isn't visible inside to_thread.
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()) / "config.yaml"

    def store_path() -> Path:
        # On the loop thread: the API server scopes get_hermes_home() to the request's profile, and
        # that scope isn't visible inside to_thread.
        from hermes_constants import get_hermes_home

        return db_path(Path(get_hermes_home()))

    async def list_chats(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        records = await asyncio.to_thread(chats.read, store_path())
        return web.json_response({"object": "memento.chats", "chats": records})

    async def merge_chats(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            body = await request.json()
        except ValueError:
            return _error(web, "Body must be JSON", 400)
        try:
            records = await asyncio.to_thread(
                chats.merge, store_path(), (body or {}).get("chats") if isinstance(body, dict) else None
            )
        except chats.InvalidChats as error:
            return _error(web, str(error), 400)
        return web.json_response({"object": "memento.chats", "chats": records})

    async def session_context(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        asked_id = request.match_info["session_id"]
        session_id = asked_id
        path = store_path()
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        db = await open_db() if callable(open_db) else None
        resolve = getattr(db, "resolve_resume_session_id", None)
        if callable(resolve):
            # Compression moves a chat to a child session; its newest calls are recorded there.
            try:
                session_id = await asyncio.to_thread(resolve, session_id) or session_id
            except Exception:
                logger.debug("memento: couldn't resolve session %s", session_id, exc_info=True)
        found = await asyncio.to_thread(context.read, path, session_id) or {}
        changes = await asyncio.to_thread(model_changes.read, path, session_id, asked_id)
        body = {
            "object": "memento.context",
            "session_id": session_id,
            **{field: found.get(field) for field in context.FIELDS},
        }
        # A store that couldn't be read says nothing rather than "no changes", so the app keeps the
        # dividers it already has instead of clearing them.
        if changes is not None:
            body["model_changes"] = changes
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return web.json_response(body)

    async def account_usage(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        provider = (request.query.get("provider") or "").strip().lower()
        if not provider:
            return _error(web, "Missing provider", 400)
        scope = profile_scope()

        def run():
            with scope():
                return usage.fetch(provider)

        result = await asyncio.to_thread(run)
        if result is None:
            result = {"provider": provider, "plan": None, "windows": []}
        return web.json_response({"object": "memento.usage", **result})

    async def session_agents(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        # On the loop thread, like store_path: the profile scope isn't visible inside to_thread.
        home = hermes_home()
        live, _ = await asyncio.to_thread(sessions.live_runs, adapter, None, home)
        found = await asyncio.to_thread(delegation.children, home, session_id, set(live))
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return web.json_response({"object": "memento.agents", "session_id": session_id, "agents": found})

    async def session_todos(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        db = await open_db() if callable(open_db) else None
        found = None
        if db is not None:
            resolve = getattr(db, "resolve_resume_session_id", None)
            if callable(resolve):
                try:
                    session_id = await asyncio.to_thread(resolve, session_id) or session_id
                except Exception:
                    logger.debug("memento: couldn't resolve session %s", session_id, exc_info=True)
            found = await asyncio.to_thread(todos.read, db, session_id)
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return web.json_response(
            {
                "object": "memento.todos",
                "session_id": session_id,
                "revision": found["revision"] if found else None,
                "todos": found["todos"] if found else None,
                "progress": found["progress"] if found else None,
            }
        )

    def list_with_clones(home: Path, projects_db: Path, session_db: Any) -> List[Dict[str, Any]]:
        # Profiles served at /p/<profile> have their own homes, which the startup resume can't see.
        clones.resume(home)
        repos.resume(home)
        return projects.read(
            projects_db, session_db, clones.pending(home), repos.pending(home), projects.pins(home)
        )

    async def list_projects(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        from hermes_constants import get_hermes_home

        # Resolved here for the same reason as store_path().
        home = Path(get_hermes_home())
        projects_db = home / "projects.db"
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        session_db = await open_db() if callable(open_db) else None
        try:
            rows = await asyncio.to_thread(list_with_clones, home, projects_db, session_db)
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        return web.json_response({"object": "memento.projects", "projects": rows})

    def hermes_home() -> Path:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())

    async def github_status(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        result = await asyncio.to_thread(github.status, hermes_home())
        return web.json_response({"object": "memento.github", **result})

    async def github_repos(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            rows = await asyncio.to_thread(github.repos, hermes_home())
        except github.GitHubError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "memento.github.repos", "repos": rows})

    async def create_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            body = await request.json()
        except ValueError:
            return _error(web, "Body must be JSON", 400)
        if not isinstance(body, dict):
            return _error(web, "Body must be an object", 400)
        try:
            home = hermes_home()
            created = await asyncio.to_thread(
                clones.start, home, body.get("name"), body.get("description"), body.get("repos", [])
            )
        except ValueError as error:
            return _error(web, str(error), 400)
        clones.spawn(home, created["slug"])
        return web.json_response({"object": "memento.project", **created}, status=202)

    async def edit_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            body = await request.json()
        except ValueError:
            return _error(web, "Body must be JSON", 400)
        if not isinstance(body, dict):
            return _error(web, "Body must be an object", 400)
        if clones.is_pending_id(request.match_info["project_id"]):
            return _error(web, "The project is still being created.", 409)
        try:
            found = await asyncio.to_thread(
                projects.update,
                hermes_home(),
                request.match_info["project_id"],
                body.get("name"),
                body.get("description"),
                body.get("archived"),
                body.get("pinned"),
            )
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        if not found:
            return _error(web, "No such project.", 404)
        events.note("projects", None, store_path(), True)
        return web.json_response({"object": "memento.project", "id": request.match_info["project_id"]})

    async def delete_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        try:
            if clones.is_pending_id(project_id):
                found = await asyncio.to_thread(
                    clones.dismiss, hermes_home(), project_id[len(clones.ID_PREFIX) :]
                )
            else:
                found = await asyncio.to_thread(projects.remove, hermes_home(), project_id)
                if found:
                    await asyncio.to_thread(repos.forget, hermes_home(), project_id)
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        if not found:
            return _error(web, "No such project.", 404)
        events.note("projects", None, store_path(), True)
        return web.json_response({"object": "memento.project", "removed": True})

    async def retry_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        if not clones.is_pending_id(project_id):
            return _error(web, "No such project.", 404)
        retried = await asyncio.to_thread(
            clones.retry, hermes_home(), project_id[len(clones.ID_PREFIX) :]
        )
        if retried is None:
            return _error(web, "No failed project to retry.", 404)
        return web.json_response({"object": "memento.project", **retried}, status=202)

    async def add_repo(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        if clones.is_pending_id(project_id):
            return _error(web, "The project is still being created.", 409)
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            added = await asyncio.to_thread(repos.add, hermes_home(), project_id, body.get("repo"))
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        except repos.RepoError as error:
            return _error(web, str(error), error.status)
        if added is None:
            return _error(web, "No such project.", 404)
        return web.json_response({"object": "memento.project.repo", **added}, status=202)

    async def remove_repo(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        if clones.is_pending_id(project_id):
            return _error(web, "The project is still being created.", 409)
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            found = await asyncio.to_thread(repos.remove, hermes_home(), project_id, body.get("repo"))
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        if not found:
            return _error(web, "That repo isn't in this project.", 404)
        return web.json_response({"object": "memento.project.repo", "removed": True}, status=202)

    async def project_usage(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        try:
            found = (
                None
                if clones.is_pending_id(project_id)
                else await asyncio.to_thread(projects.usage, hermes_home(), project_id)
            )
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        if found is None:
            return _error(web, "No such project.", 404)
        return web.json_response({"object": "memento.project.usage", **found})

    async def resolve_project(project_id: str):
        """A project, or the response that says why it can't be read — its two routes' own answer."""
        try:
            return (
                await asyncio.to_thread(
                    sessions._project, hermes_home() / "projects.db", project_id
                ),
                None,
            )
        except ValueError:
            return None, _error(web, "No such project.", 404)
        except ImportError:
            return None, _error(web, "This Hermes version has no Projects.", 501)

    async def project_library(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        # A project still being cloned has no library to list yet.
        if clones.is_pending_id(project_id):
            return web.json_response(
                {"object": "memento.library", "project_id": project_id, "folders": []}
            )
        project, refused = await resolve_project(project_id)
        if refused is not None:
            return refused
        root = library.library_root(project)
        folders = await asyncio.to_thread(library.tree, root)
        return web.json_response(
            {"object": "memento.library", "project_id": project_id, "folders": folders}
        )

    async def project_tasks(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        # A project still being cloned has no checkout to read a task from yet.
        if clones.is_pending_id(project_id):
            return web.json_response(
                {"object": "memento.tasks", "project_id": project_id, **tasks.empty()}
            )
        project, refused = await resolve_project(project_id)
        if refused is not None:
            return refused
        try:
            found = await asyncio.to_thread(tasks.read, hermes_home(), project.folders)
        except github.GitHubError as error:
            # GitHub's own reason is the answer: there's no account on this server, or its token
            # was refused, and the sheet says so instead of showing an empty frontier.
            return _error(web, str(error), error.status)
        return web.json_response({"object": "memento.tasks", "project_id": project_id, **found})

    async def project_afk(request: "web.Request") -> "web.Response":
        """Whether the project is left to work its own tasks, and why it can't be."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        # A project still being cloned has no checkout to leave to work, and never offers the switch.
        if clones.is_pending_id(project_id):
            return _error(web, "The project is still being created.", 409)
        project, refused = await resolve_project(project_id)
        if refused is not None:
            return refused
        found = await asyncio.to_thread(
            afk.read,
            hermes_home(),
            project_id,
            project.folders,
            bool(getattr(project, "archived", False)),
        )
        return web.json_response({"object": "memento.afk", "project_id": project_id, **found})

    async def post_project_afk(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        if clones.is_pending_id(project_id):
            return _error(web, "The project is still being created.", 409)
        body = await json_body(request)
        on = body.get("on") if body else None
        if not isinstance(on, bool):
            return _error(web, "on must be true or false.", 400)
        project, refused = await resolve_project(project_id)
        if refused is not None:
            return refused
        try:
            found = await asyncio.to_thread(
                afk.set_on,
                hermes_home(),
                project_id,
                project.folders,
                on,
                bool(getattr(project, "archived", False)),
            )
        except afk.Refused as why:
            # The project can't be left to work: its reason is the answer, and nothing is written.
            return _error(web, str(why), 409)
        return web.json_response({"object": "memento.afk", "project_id": project_id, **found})

    async def session_db():
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        return await open_db() if callable(open_db) else None

    async def json_body(request: "web.Request"):
        try:
            body = await request.json()
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    async def workspace_response(record: Dict[str, Any] | None):
        return web.json_response(
            {
                "object": "memento.workspace",
                "workspace": record,
                "instructions": prompt_builder.session_prompt(record) if record else None,
                "blocked": await asyncio.to_thread(sessions.blocked, hermes_home(), record),
            }
        )

    async def post_workspace(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        session_id = request.match_info["session_id"]
        path, home = store_path(), hermes_home()
        try:
            record = await asyncio.to_thread(
                sessions.ensure,
                path,
                home,
                session_id,
                body.get("project_id"),
                body.get("task"),
                body.get("mode"),
            )
        except ImportError:
            return _error(web, "This Hermes version has no projects or worktrees.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        except sessions.WorkspaceError as error:
            return _error(web, str(error), error.status)
        # On the loop thread: the override is keyed by the request's profile scope.
        sessions.apply_cwd(session_id, record["path"])
        db = await session_db()
        if db is not None:
            await asyncio.to_thread(sessions.stamp, db, record)
        return await workspace_response(record)

    async def get_workspace(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        # The session's own record: one reached through the parent walk is another session's, whose
        # pending plan must never read as this one's (the app would approve its file).
        record = await asyncio.to_thread(
            sessions.record_of, store_path(), request.match_info["session_id"]
        )
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return await workspace_response(record)

    async def post_mode(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            record = await asyncio.to_thread(
                sessions.set_mode, store_path(), request.match_info["session_id"], body.get("mode")
            )
        except ValueError as error:
            return _error(web, str(error), 400)
        except sessions.WorkspaceError as error:
            return _error(web, str(error), error.status)
        if record is None:
            return _error(web, "This session has no workspace yet", 404)
        if record["mode"] == "auto":
            # On the loop thread: Hermes's approval queues belong to it.
            try:
                sessions.answer_waiting(request.match_info["session_id"])
            except Exception:
                logger.debug("memento: answering waiting approvals failed", exc_info=True)
        return await workspace_response(record)

    async def remove_workspace(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        try:
            result = await asyncio.to_thread(sessions.remove, store_path(), session_id)
        except sessions.WorkspaceError as error:
            return _error(web, str(error), error.status)
        if result.get("removed"):
            sessions._clear_cwd(session_id)
        return web.json_response({"object": "memento.workspace.removed", **result})

    async def session_pr(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path, home = store_path(), hermes_home()
        record = await asyncio.to_thread(sessions.record_for, path, home, request.match_info["session_id"])

        def lookup():
            """Each repo's pull requests, newest first; the newest one each is what resolves."""
            per_repo = []
            for repo in (record or {}).get("repos", []):
                if not repo.get("path") or not repo.get("branch"):
                    continue
                # Strict: a GitHub failure must not come back as "no pull requests", which the app
                # stores over the ones it already knows and the PRs tab empties out.
                per_repo.append(
                    github.pull_requests(home, repo["repo_root"], repo["branch"], strict=True)
                )
            return per_repo

        try:
            per_repo = await asyncio.to_thread(lookup) if record else []
        except github.GitHubError as error:
            return _error(web, str(error), error.status)
        prs = [pr for group in per_repo for pr in group]
        # A repo's newest is the one the session is working on: its merge is what resolves it.
        if any(group and group[0]["state"] == "merged" for group in per_repo):
            try:
                await asyncio.to_thread(merges.check, home, {request.match_info["session_id"]})
            except Exception:
                logger.debug("memento: resolving a merged session failed", exc_info=True)
        return web.json_response({"object": "memento.prs", "prs": prs})

    async def session_library(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        record = await asyncio.to_thread(
            sessions.record_for, store_path(), hermes_home(), session_id
        )
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        if not record:
            return web.json_response(
                {
                    "object": "memento.library",
                    "session_id": session_id,
                    "worktree": None,
                    "folders": [],
                }
            )
        root, slug = await asyncio.to_thread(library.folder_and_worktree, hermes_home(), record)
        folders = await asyncio.to_thread(library.tree, root, slug)
        return web.json_response(
            {
                "object": "memento.library",
                "session_id": session_id,
                "worktree": slug,
                "folders": folders,
            }
        )

    async def close_session(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path, home = store_path(), hermes_home()
        record = await asyncio.to_thread(sessions.record_for, path, home, session_id)
        if not record:
            return web.json_response({"object": "memento.closed", "removed": True, "kept": [], "results": []})
        # Before the branches go: a tree whose commits are only on its remote branch can still go.
        try:
            removed = await asyncio.to_thread(sessions.remove, path, record["session_id"])
        except sessions.WorkspaceError as error:
            removed = {"removed": False, "kept": [], "error": str(error)}
        if removed.get("removed"):
            sessions._clear_cwd(session_id)
        results = await asyncio.to_thread(ship.close, home, record)
        return web.json_response({"object": "memento.closed", **removed, "results": results})

    async def live_runs(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        owned = owned_runs(request)
        # On the loop thread: the profile scope isn't visible inside to_thread.
        home = hermes_home()
        roots: Dict[str, str] = {}
        live, run_ids = await asyncio.to_thread(
            sessions.live_runs, adapter, owned=owned, home=home, roots=roots
        )
        try:
            waiting = await asyncio.to_thread(
                sessions.waiting, adapter, store_path(), home, owned=owned, roots=roots
            )
        except Exception:
            logger.debug("memento: reading waiting sessions failed", exc_info=True)
            waiting = {}
        try:
            # A goal paused or blocked by the judge waits on the user too, and outranks its own note:
            # a question the run asked is what the turn is doing right now.
            waiting = {**await asyncio.to_thread(goal.waiting, home), **waiting}
        except Exception:
            logger.debug("memento: reading waiting goals failed", exc_info=True)
        return web.json_response(
            {"object": "memento.runs", "sessions": live, "run_ids": run_ids, "waiting": waiting}
        )

    async def stream_events(request: "web.Request") -> "web.StreamResponse":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        since = request.query.get("since")
        try:
            cursor = int(since) if since else None
        except ValueError:
            return _error(web, "since must be a number", 400)
        path = store_path()
        home = hermes_home()
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        db = await open_db() if callable(open_db) else None
        return await stream.serve(
            web, request, stream.sse_headers(adapter, request), path, str(path), db, home,
            cursor, VERSION,
            request.query.get("device") or None,
        )

    def goal_scope():
        # Hermes keeps a goal in this profile's session database (``state_meta``), so every read and
        # write re-enters the request's profile scope inside the worker thread.
        return profile_scope()

    async def goal_view(session_id: str, extra: Optional[Dict[str, Any]] = None) -> "web.Response":
        scope = goal_scope()

        def run():
            with scope():
                return goal.read(session_id)

        found = await asyncio.to_thread(run)
        return web.json_response(
            {"object": "memento.goal", "session_id": session_id, **(extra or {}), **found}
        )

    async def get_goal(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return await goal_view(request.match_info["session_id"])

    async def post_goal(request: "web.Request") -> "web.Response":
        """Sets the session's goal from the wizard's ``/goal`` text, and its quality gates."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        session_id = request.match_info["session_id"]
        scope = goal_scope()

        def run():
            with scope():
                return goal.apply(
                    session_id, body.get("command"), body.get("gates"), body.get("max_turns")
                )

        try:
            applied = await asyncio.to_thread(run)
        except goal.GoalError as error:
            return _error(web, str(error), error.status)
        except ValueError as error:
            return _error(web, str(error), 400)
        events.note("runs", session_id, store_path(), True)
        return web.json_response({"object": "memento.goal", "session_id": session_id, **applied})

    async def post_goal_control(request: "web.Request") -> "web.Response":
        """The sheet's actions: pause, resume or clear the session's goal."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        session_id = request.match_info["session_id"]
        scope = goal_scope()

        def run():
            with scope():
                return goal.control(session_id, body.get("action"))

        try:
            done = await asyncio.to_thread(run)
        except goal.GoalError as error:
            return _error(web, str(error), error.status)
        events.note("runs", session_id, store_path(), True)
        return web.json_response({"object": "memento.goal", "session_id": session_id, **done})

    async def push_subscribe(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            await asyncio.to_thread(push.subscribe, store_path(), body)
        except push.PushError as exc:
            return _error(web, str(exc), 400)
        return web.json_response({"object": "memento.push", "subscribed": True})

    async def push_mute(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        muted = body.get("muted") if body else None
        if not isinstance(muted, bool):
            return _error(web, "Missing muted", 400)
        # Which bot character the profile is, for the notification's picture (0.33).
        character = body.get("bot")
        if character is not None and not (isinstance(character, str) and push.BOT_ID.match(character)):
            return _error(web, "Not a bot", 400)
        await asyncio.to_thread(push.set_bot_muted, store_path(), muted)
        if character:
            await asyncio.to_thread(push.set_bot, store_path(), character)
        return web.json_response({"object": "memento.push", "muted": muted})

    async def push_unsubscribe(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        endpoint = body.get("endpoint") if body else None
        if not isinstance(endpoint, str) or not endpoint:
            return _error(web, "Missing endpoint", 400)
        await asyncio.to_thread(push.unsubscribe, store_path(), endpoint)
        return web.json_response({"object": "memento.push", "subscribed": False})

    app.router.add_get(f"{PREFIX}/info", info)
    app.router.add_get(f"{PREFIX}/chats", list_chats)
    app.router.add_post(f"{PREFIX}/chats", merge_chats)
    app.router.add_get(f"{PREFIX}/cron/runs", cron_runs)
    app.router.add_get(f"{PREFIX}/projects", list_projects)
    app.router.add_post(f"{PREFIX}/projects", create_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}", edit_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/remove", delete_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/retry", retry_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/repos", add_repo)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/repos/remove", remove_repo)
    app.router.add_get(f"{PREFIX}/projects/{{project_id}}/usage", project_usage)
    app.router.add_get(f"{PREFIX}/projects/{{project_id}}/library", project_library)
    app.router.add_get(f"{PREFIX}/projects/{{project_id}}/tasks", project_tasks)
    app.router.add_get(f"{PREFIX}/projects/{{project_id}}/afk", project_afk)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/afk", post_project_afk)
    app.router.add_post(f"{PREFIX}/model", set_host_model)
    app.router.add_get(f"{PREFIX}/fallbacks", get_fallbacks)
    app.router.add_get(f"{PREFIX}/skills", list_skills)
    app.router.add_get(f"{PREFIX}/mcp", list_mcp_servers)
    app.router.add_get(f"{PREFIX}/mcp/catalogue", list_mcp_catalogue)
    app.router.add_get(f"{PREFIX}/mcp/catalogue/{{name}}", get_mcp_catalogue_entry)
    app.router.add_post(f"{PREFIX}/mcp/install", install_mcp_server)
    app.router.add_post(f"{PREFIX}/mcp/custom", add_custom_mcp_server)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/enabled", set_mcp_server_enabled)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/access", start_mcp_access)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/access/callback", deliver_mcp_access)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/config", save_mcp_server)
    app.router.add_get(f"{PREFIX}/mcp/{{name}}/tools", read_mcp_tools)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/tools", probe_mcp_tools)
    # One server's own block, registered after the Catalogue's names so `mcp/catalogue` is the
    # Catalogue rather than a server called catalogue.
    app.router.add_get(f"{PREFIX}/mcp/{{name}}", get_mcp_server)
    app.router.add_delete(f"{PREFIX}/mcp/{{name}}", remove_mcp_server)
    app.router.add_post(f"{PREFIX}/fallbacks", set_fallbacks)
    app.router.add_get(f"{PREFIX}/github", github_status)
    app.router.add_get(f"{PREFIX}/github/repos", github_repos)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/label", label_session)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/context", session_context)
    app.router.add_get(f"{PREFIX}/usage", account_usage)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/todos", session_todos)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/agents", session_agents)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/workspace", post_workspace)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/workspace", get_workspace)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/workspace/remove", remove_workspace)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/mode", post_mode)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/prs", session_pr)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/library", session_library)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/close", close_session)
    async def answer_clarify(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        run_id = request.match_info["run_id"]
        clarify_id = clarify.resolve(run_id, body.get("clarify_id"), body.get("answers"), body.get("outcome"))
        if clarify_id is None:
            return _error(web, f"Run has no pending question: {run_id}", 409)
        return web.json_response(
            {"object": "memento.clarify_response", "run_id": run_id, "clarify_id": clarify_id, "resolved": True}
        )

    async def upload_attachment(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        name = request.query.get("name", "")
        try:
            data = await request.read()
        except web.HTTPRequestEntityTooLarge:
            return _error(web, "The file is too large.", 413)
        if not data:
            return _error(web, "The file is empty.", 400)
        if len(data) > attachments.MAX_BYTES:
            return _error(web, "The file is too large.", 413)
        try:
            saved = await asyncio.to_thread(
                attachments.save, hermes_home(), request.match_info["session_id"], name, data
            )
        except ValueError as exc:
            return _error(web, str(exc), 400)
        except OSError:
            logger.warning("memento: couldn't save an attachment", exc_info=True)
            return _error(web, "Couldn't save the file on the server.", 500)
        return web.json_response(
            {"object": "memento.attachment", "name": saved.name, "path": str(saved), "size": len(data)}
        )

    # One clip at a time, so a long dictation can't starve the agent's turns of CPU.
    dictating = asyncio.Lock()

    async def dictate(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            data = await request.read()
        except web.HTTPRequestEntityTooLarge:
            return _error(web, "The recording is too long.", 413)
        if not data:
            return _error(web, "The recording is empty.", 400)
        if len(data) > dictation.MAX_BYTES:
            return _error(web, "The recording is too long.", 413)
        hint = dictation.clean_hint(request.query.get("hint"))
        context = dictation.clean_context(request.query.get("context"))
        async with dictating:
            try:
                result = await asyncio.to_thread(
                    dictation.transcribe, data, request.headers.get("content-type"), hint, context
                )
            except dictation.DictationError as error:
                return _error(web, str(error), error.status)
            except Exception:
                logger.warning("memento: dictation failed", exc_info=True)
                return _error(web, "Transcription failed.", 502)
        return web.json_response({"object": "memento.dictation", **result})

    async def warm_dictation(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        result = await asyncio.to_thread(dictation.warm)
        return web.json_response({"object": "memento.dictation_warm", **result})

    async def served_file(request: "web.Request", resolve: Any, allowed: Any = None) -> "web.StreamResponse":
        """Serves the file a query's ``path`` names: ``resolve`` validates it, ``allowed`` may refuse
        it (a library file has to sit under a project's library folder)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            file = await asyncio.to_thread(resolve, request.query.get("path", ""))
        except media.MediaError as error:
            return _error(web, str(error), error.status)
        if allowed is not None and not await asyncio.to_thread(allowed, file):
            return _error(web, "Not a library file.", 404)
        return web.FileResponse(file, headers={"content-type": media.content_type(file)})

    async def serve_media(request: "web.Request") -> "web.StreamResponse":
        return await served_file(request, media.image_file)

    app.router.add_get(f"{PREFIX}/media", serve_media)

    async def serve_library_file(request: "web.Request") -> "web.StreamResponse":
        return await served_file(
            request, media.library_file, lambda file: library.holds(hermes_home(), file)
        )

    app.router.add_get(f"{PREFIX}/library/file", serve_library_file)
    app.router.add_post(f"{PREFIX}/dictation", dictate)
    app.router.add_post(f"{PREFIX}/dictation/warm", warm_dictation)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/attachments", upload_attachment)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/goal", get_goal)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/goal", post_goal)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/goal/control", post_goal_control)
    app.router.add_get(f"{PREFIX}/runs/live", live_runs)
    app.router.add_get(f"{PREFIX}/events", stream_events)
    app.router.add_post(f"{PREFIX}/push", push_subscribe)
    app.router.add_post(f"{PREFIX}/push/remove", push_unsubscribe)
    app.router.add_post(f"{PREFIX}/push/mute", push_mute)
    app.router.add_post(f"{PREFIX}/runs/{{run_id}}/clarify", answer_clarify)
    # The profile the request being served belongs to, read on the loop thread (None when this
    # Hermes has no profile scope). One definition only: everything below resolves it by name.
    def request_profile():
        try:
            from gateway.platforms.api_server import _api_request_profile

            return _api_request_profile.get()
        except Exception:
            return None

    async def queue_response(session_id: str, path: Path) -> "web.Response":
        found = await asyncio.to_thread(outbox.read, path, session_id)
        runs = outbox.session_runs(adapter, await outbox.session_ids(adapter, session_id))
        statuses = {run.get("run_id"): run.get("status") for run in runs}
        for item in found["sent"]:
            item["run_status"] = statuses.get(item["run_id"])
        state = outbox.state(runs, found["resumed_at"])
        return web.json_response(
            {
                "object": "memento.queue",
                "items": found["items"],
                "sent": found["sent"],
                "paused": state == "paused",
            }
        )

    def follow_queue(request: "web.Request", session_id: str, path: Path) -> None:
        outbox.watch(session_id, request_profile(), path, request.headers.get("Authorization"))
        events.note("session", session_id, path, True)

    async def get_queue(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return await queue_response(request.match_info["session_id"], store_path())

    async def add_queued(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        files = body.get("attachments") or []
        if not isinstance(files, list) or not all(isinstance(file, dict) for file in files):
            return _error(web, "attachments must be a list", 400)
        files = [
            {key: file[key] for key in ("name", "type", "size", "path") if key in file}
            for file in files[:20]
        ]
        path = store_path()
        try:
            run = outbox.clean_body(session_id, body.get("body"))
            item = await asyncio.to_thread(
                outbox.add, path, session_id, request_profile(), body.get("text", ""), files, run
            )
        except ValueError as error:
            return _error(web, str(error), 400)
        follow_queue(request, session_id, path)
        return web.json_response({"object": "memento.queued", "item": item})

    async def remove_queued(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path = store_path()
        removed = await asyncio.to_thread(outbox.remove, path, session_id, request.match_info["item_id"])
        events.note("session", session_id, path, True)
        return web.json_response({"object": "memento.queue.removed", "removed": removed})

    async def send_queued(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path = store_path()
        if not await asyncio.to_thread(outbox.promote, path, session_id, request.match_info["item_id"]):
            return _error(web, "That message isn't waiting any more.", 404)
        follow_queue(request, session_id, path)
        return await queue_response(session_id, path)

    async def steer_queued(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path = store_path()
        runs = outbox.session_runs(adapter, await outbox.session_ids(adapter, session_id))
        running = [run for run in runs if run.get("status") == "running" and run.get("run_id")]
        if not running:
            return _error(web, "The reply isn't running, so it can't be steered.", 409)
        run_id = max(running, key=lambda run: float(run.get("created_at") or 0))["run_id"]
        row = await asyncio.to_thread(outbox.take, path, session_id, request.match_info["item_id"])
        if row is None:
            return _error(web, "That message isn't waiting any more.", 404)
        if row["attachments"] or not row["text"].strip():
            await asyncio.to_thread(outbox.put_back, path, row)
            return _error(web, "Only text can steer a reply.", 409)
        try:
            await outbox.post(
                adapter,
                request_profile(),
                f"/v1/runs/{run_id}/steer",
                {"input": row["text"]},
                authorization=request.headers.get("Authorization"),
            )
        except outbox.StartError as error:
            await asyncio.to_thread(outbox.put_back, path, row)
            return _error(web, str(error), 409 if error.permanent else 502)
        # A steer the agent never reads comes back when the run ends; see outbox.tick.
        follow_queue(request, session_id, path)
        return web.json_response(
            {"object": "memento.queue.steered", "id": row["id"], "run_id": run_id, "text": row["text"]}
        )

    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/queue", get_queue)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/queue", add_queued)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/queue/{{item_id}}/remove", remove_queued)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/queue/{{item_id}}/send", send_queued)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/queue/{{item_id}}/steer", steer_queued)
    async def research_view(path: Path, mission_id: str) -> "web.Response":
        found = await asyncio.to_thread(research.mission, path, mission_id)
        if found is None:
            return _error(web, "No such mission.", 404)
        return web.json_response({"object": "memento.research.mission", "mission": found})

    async def research_step(request: "web.Request", step, *args) -> "web.Response":
        """Runs a step on a mission and answers with the mission as it now is."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path, mission_id = store_path(), request.match_info["mission_id"]
        try:
            found = await asyncio.to_thread(step, path, mission_id, *args)
        except research.ResearchError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "memento.research.mission", "mission": found})

    async def list_research(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path = store_path()
        # A /p/<profile> bot's missions are only seen once it asks.
        await asyncio.to_thread(research.resume, path)
        rows = await asyncio.to_thread(research.missions, path)
        return web.json_response(
            {"object": "memento.research", "missions": rows, "unavailable": research.available()}
        )

    async def create_research(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        reason = research.available()
        if reason:
            return _error(web, reason, 501)
        path, profile = store_path(), request_profile()
        try:
            found = await asyncio.to_thread(
                research.create, path, profile, body.get("input"), body.get("type")
            )
        except research.ResearchError as error:
            return _error(web, str(error), error.status)
        research.spawn(path, found["id"], profile)
        return web.json_response({"object": "memento.research.mission", "mission": found}, status=202)

    async def get_research(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return await research_view(store_path(), request.match_info["mission_id"])

    async def start_researcher(request: "web.Request", path: Path, found: Dict[str, Any]) -> None:
        """Starts the mission's researcher as an ordinary run, with the key the app asked with."""
        profile = request_profile()
        research.watch(path, found["id"], profile)
        try:
            started = await outbox.post(
                adapter,
                profile,
                "/v1/runs",
                research.run_body(found),
                authorization=request.headers.get("Authorization"),
            )
        except outbox.StartError as error:
            await asyncio.to_thread(
                research.set_run, path, found["id"], None, f"Couldn't start the research: {error}"
            )
            return
        run_id = started.get("run_id")
        if isinstance(run_id, str) and run_id:
            await asyncio.to_thread(research.set_run, path, found["id"], run_id)
        else:
            await asyncio.to_thread(
                research.set_run, path, found["id"], None, "Hermes didn't start the research."
            )

    async def research_brief(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.confirm_brief, body)
        if answer.status == 200:
            research.spawn(store_path(), request.match_info["mission_id"], request_profile())
        return answer

    async def research_edit(request: "web.Request") -> "web.Response":
        return await research_step(request, research.edit_brief)

    async def research_start(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.approve_scope, body)
        if answer.status != 200:
            return answer
        path, mission_id = store_path(), request.match_info["mission_id"]
        found = await asyncio.to_thread(research.mission, path, mission_id)
        await start_researcher(request, path, found)
        return await research_view(path, mission_id)

    async def research_format(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.make_format, body.get("format"))
        if answer.status == 200:
            research.spawn(store_path(), request.match_info["mission_id"], request_profile())
        return answer

    async def research_followup(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.followup, body)
        if answer.status != 200:
            return answer
        path, mission_id = store_path(), request.match_info["mission_id"]
        found = await asyncio.to_thread(research.mission, path, mission_id)
        # The same session, so the researcher knows what it already read.
        await start_researcher(request, path, found)
        return await research_view(path, mission_id)

    async def research_rewrite(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.rewrite, body)
        if answer.status == 200:
            research.spawn(store_path(), request.match_info["mission_id"], request_profile())
        return answer

    async def research_retry(request: "web.Request") -> "web.Response":
        answer = await research_step(request, research.retry)
        if answer.status != 200:
            return answer
        path, mission_id = store_path(), request.match_info["mission_id"]
        found = await asyncio.to_thread(research.mission, path, mission_id)
        if found["stage"] == "reading":
            # The same session, so the researcher carries on from what it already recorded.
            await start_researcher(request, path, found)
        else:
            research.spawn(path, mission_id, request_profile())
        return await research_view(path, mission_id)

    async def remove_research(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path, mission_id = store_path(), request.match_info["mission_id"]
        found = await asyncio.to_thread(research.remove, path, mission_id)
        if found is None:
            return _error(web, "No such mission.", 404)
        if found.get("run_id") and research._run_status(found["run_id"]) in research.ACTIVE:
            try:
                await outbox.post(
                    adapter,
                    request_profile(),
                    f"/v1/runs/{found['run_id']}/stop",
                    {},
                    authorization=request.headers.get("Authorization"),
                )
            except outbox.StartError:
                logger.debug("memento: couldn't stop the researcher of %s", mission_id, exc_info=True)
        return web.json_response({"object": "memento.research.removed", "removed": True})

    app.router.add_get(f"{PREFIX}/research", list_research)
    app.router.add_post(f"{PREFIX}/research", create_research)
    app.router.add_get(f"{PREFIX}/research/{{mission_id}}", get_research)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/brief", research_brief)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/edit", research_edit)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/start", research_start)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/formats", research_format)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/followup", research_followup)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/rewrite", research_rewrite)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/retry", research_retry)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/remove", remove_research)
    # The goal loop judges finished turns and posts continuations through the server's own scope
    # readers and adapter, which only exist here; see goal.py.
    goal.wire(adapter, scope=profile_scope, profile=request_profile)
    mirror_for_profiles(app, web)
    logger.info("memento: serving %s on the API server", PREFIX)


def register(ctx) -> None:
    register_hook = getattr(ctx, "register_hook", None)
    if register_hook is not None:
        register_hook("post_api_request", context.record)
        register_hook("post_api_request", model_changes.record)
        register_hook("post_api_request", community.record)
        register_hook("pre_tool_call", sessions.before_tool)
        register_hook("pre_tool_call", research.before_tool)
        register_hook("pre_llm_call", sessions.before_llm)
        register_hook("on_session_start", sessions.started)
        register_hook("post_llm_call", sessions.after_llm)
        register_hook("on_session_end", sessions.after_run)
        # After the hooks above, so a turn's plan is pending by the time its end is announced.
        register_hook("pre_llm_call", alerts.turn_started)
        register_hook("on_session_end", alerts.turn_finished)
        register_hook("pre_llm_call", events.on_turn_start)
        register_hook("post_api_request", events.on_model_call)
        register_hook("pre_tool_call", events.on_tool)
        register_hook("post_tool_call", events.on_tool)
        register_hook("pre_approval_request", events.on_approval_request)
        register_hook("post_approval_response", events.on_approval)
        register_hook("post_approval_response", approvals.settled)
        register_hook("on_session_end", events.on_turn_end)
        # A session with a goal is judged when its turn ends, and continued from here; see goal.py.
        register_hook("post_llm_call", goal.remember)
        register_hook("on_session_end", goal.turn_finished)
        # The run is over, so a queued message can go now rather than at the next tick.
        register_hook("on_session_end", lambda **_kwargs: outbox.wake())
        # And AFK looks for the next task now when a project session ends; see afk.py.
        register_hook("on_session_end", afk.after_run)
    register_cli = getattr(ctx, "register_cli_command", None)
    if register_cli is not None:
        register_cli(
            name="memento",
            help="Link this profile to the Gots app",
            setup_fn=link.setup_cli,
            description="hermes memento link <code> --site <url>, unlink or status",
        )
    ship.register(ctx)
    library.register(ctx)
    research.register(ctx)
    register_handler = getattr(ctx, "register_platform_handler", None)
    if register_handler is None:
        logger.warning("memento: this Hermes version can't add API server routes; update Hermes")
        return
    register_handler("api_server", _wire_api_server)
