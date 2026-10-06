"""Memento's Hermes plugin.

Adds routes to the API server, so the Memento app (which only talks to the API server, with its key)
can read cron run history from Hermes's execution ledger instead of piecing it together on each
device, keep its chat list on the server (``chats.py``), report each chat's context use
(``context.py``) and the agent's todo list (``todos.py``), list and create Hermes Projects (``projects.py``) with GitHub repos cloned into
them (``github.py``), run project sessions in their own worktrees with a permission mode
(``sessions.py``) and label its chats as Memento's. The dashboard half lives in ``dashboard/``.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any, Dict, List

from . import chats, cleanup, context, github, projects, sessions, todos
from .store import db_path

logger = logging.getLogger(__name__)

PREFIX = "/api/plugins/memento"
# Memento shows 24 runs per job.
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


def _wire_api_server(app: Any, adapter: Any) -> None:
    from aiohttp import web

    # The hooks have no other way to the session store.
    sessions.adapter = adapter

    async def daily_cleanup(_app: Any):
        from hermes_constants import get_hermes_home

        task = asyncio.ensure_future(cleanup.run_daily(adapter, Path(get_hermes_home())))
        yield
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

    async def info(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return web.json_response(
            {
                "name": "memento",
                "version": VERSION,
                "features": [
                    "cron_runs",
                    "session_label",
                    "chats",
                    "context",
                    "todos",
                    "projects",
                    "github",
                    "sessions",
                    "runs",
                    "prs",
                ],
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
        labelled = await asyncio.to_thread(sessions.label, db, session_id)
        if not labelled:
            return _error(web, "Session not found", 404)
        return web.json_response({"id": session_id, "source": sessions.SESSION_SOURCE})

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
        session_id = request.match_info["session_id"]
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
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return web.json_response(
            {
                "object": "memento.context",
                "session_id": session_id,
                **{field: found.get(field) for field in context.FIELDS},
            }
        )

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
            }
        )

    async def list_projects(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        from hermes_constants import get_hermes_home

        # Resolved here for the same reason as store_path().
        projects_db = Path(get_hermes_home()) / "projects.db"
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        session_db = await open_db() if callable(open_db) else None
        try:
            rows = await asyncio.to_thread(projects.read, projects_db, session_db)
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
            created = await asyncio.to_thread(
                projects.create,
                hermes_home(),
                body.get("name"),
                body.get("description"),
                body.get("repos", []),
            )
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        except github.GitHubError as error:
            return _error(web, str(error), error.status)
        except ValueError as error:
            return _error(web, str(error), 400)
        return web.json_response({"object": "memento.project", **created})

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
        try:
            found = await asyncio.to_thread(
                projects.update,
                hermes_home(),
                request.match_info["project_id"],
                body.get("name"),
                body.get("description"),
            )
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        if not found:
            return _error(web, "No such project.", 404)
        return web.json_response({"object": "memento.project", "id": request.match_info["project_id"]})

    async def delete_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            found = await asyncio.to_thread(
                projects.remove, hermes_home(), request.match_info["project_id"]
            )
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        if not found:
            return _error(web, "No such project.", 404)
        return web.json_response({"object": "memento.project", "removed": True})

    async def session_db():
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        return await open_db() if callable(open_db) else None

    async def json_body(request: "web.Request"):
        try:
            body = await request.json()
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    def workspace_response(record: Dict[str, Any] | None):
        return web.json_response(
            {
                "object": "memento.workspace",
                "workspace": record,
                "instructions": sessions.instructions(record) if record else None,
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
        return workspace_response(record)

    async def get_workspace(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        record = await asyncio.to_thread(
            sessions.record_for, store_path(), hermes_home(), request.match_info["session_id"]
        )
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return workspace_response(record)

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
        if record is None:
            return _error(web, "This session has no workspace yet", 404)
        return workspace_response(record)

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
            found = []
            for repo in (record or {}).get("repos", []):
                if not repo.get("path") or not repo.get("branch"):
                    continue
                pr = github.pull_request(home, repo["repo_root"], repo["branch"])
                if pr:
                    found.append(pr)
            return found

        prs = await asyncio.to_thread(lookup) if record else []
        return web.json_response({"object": "memento.prs", "prs": prs})

    async def live_runs(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return web.json_response({"object": "memento.runs", "sessions": sessions.live_runs(adapter)})

    app.router.add_get(f"{PREFIX}/info", info)
    app.router.add_get(f"{PREFIX}/chats", list_chats)
    app.router.add_post(f"{PREFIX}/chats", merge_chats)
    app.router.add_get(f"{PREFIX}/cron/runs", cron_runs)
    app.router.add_get(f"{PREFIX}/projects", list_projects)
    app.router.add_post(f"{PREFIX}/projects", create_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}", edit_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/remove", delete_project)
    app.router.add_get(f"{PREFIX}/github", github_status)
    app.router.add_get(f"{PREFIX}/github/repos", github_repos)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/label", label_session)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/context", session_context)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/todos", session_todos)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/workspace", post_workspace)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/workspace", get_workspace)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/workspace/remove", remove_workspace)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/mode", post_mode)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/prs", session_pr)
    app.router.add_get(f"{PREFIX}/runs/live", live_runs)
    logger.info("memento: serving %s on the API server", PREFIX)


def register(ctx) -> None:
    register_hook = getattr(ctx, "register_hook", None)
    if register_hook is not None:
        register_hook("post_api_request", context.record)
        register_hook("pre_tool_call", sessions.before_tool)
        register_hook("pre_llm_call", sessions.before_llm)
        register_hook("on_session_end", sessions.after_run)
    register_handler = getattr(ctx, "register_platform_handler", None)
    if register_handler is None:
        logger.warning("memento: this Hermes version can't add API server routes; update Hermes")
        return
    register_handler("api_server", _wire_api_server)
