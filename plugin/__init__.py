"""Memento's Hermes plugin.

Adds routes to the API server, so the Memento app (which only talks to the API server, with its key)
can read cron run history from Hermes's execution ledger instead of piecing it together on each
device, keep its chat list on the server (``chats.py``), and label its chats as Memento's. The
dashboard half lives in ``dashboard/``.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any, Dict, List

from . import chats

logger = logging.getLogger(__name__)

PREFIX = "/api/plugins/memento"
# Memento shows 24 runs per job.
DEFAULT_PER_JOB = 24
MAX_PER_JOB = 200
# The dashboard shows a session's source as its label. /api/sessions only accepts a fixed set of
# sources, so Memento's chats start as the API server's and the plugin relabels them.
SESSION_SOURCE = "memento"
RELABELLED_SOURCES = ("api_server", "unknown")


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


def _label_session(db: Any, session_id: str) -> bool:
    def write(conn):
        placeholders = ", ".join("?" for _ in RELABELLED_SOURCES)
        # Never takes a session from another surface (Telegram, the CLI, ...).
        cursor = conn.execute(
            f"UPDATE sessions SET source = ? WHERE id = ? AND source IN ({placeholders})",
            (SESSION_SOURCE, session_id, *RELABELLED_SOURCES),
        )
        if cursor.rowcount:
            return True
        row = conn.execute("SELECT source FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return bool(row) and row[0] == SESSION_SOURCE

    return db._execute_write(write)


def _error(web: Any, message: str, status: int):
    # The API server's own error shape, so clients read every error the same way.
    return web.json_response({"error": {"message": message}}, status=status)


def _wire_api_server(app: Any, adapter: Any) -> None:
    from aiohttp import web

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
                "features": ["cron_runs", "session_label", "chats"],
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
        labelled = await asyncio.to_thread(_label_session, db, session_id)
        if not labelled:
            return _error(web, "Session not found", 404)
        return web.json_response({"id": session_id, "source": SESSION_SOURCE})

    def chats_path() -> Path:
        # On the loop thread: the API server scopes get_hermes_home() to the request's profile, and
        # that scope isn't visible inside to_thread.
        from hermes_constants import get_hermes_home

        return chats.db_path(Path(get_hermes_home()))

    async def list_chats(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        records = await asyncio.to_thread(chats.read, chats_path())
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
                chats.merge, chats_path(), (body or {}).get("chats") if isinstance(body, dict) else None
            )
        except chats.InvalidChats as error:
            return _error(web, str(error), 400)
        return web.json_response({"object": "memento.chats", "chats": records})

    app.router.add_get(f"{PREFIX}/info", info)
    app.router.add_get(f"{PREFIX}/chats", list_chats)
    app.router.add_post(f"{PREFIX}/chats", merge_chats)
    app.router.add_get(f"{PREFIX}/cron/runs", cron_runs)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/label", label_session)
    logger.info("memento: serving %s on the API server", PREFIX)


def register(ctx) -> None:
    register_handler = getattr(ctx, "register_platform_handler", None)
    if register_handler is None:
        logger.warning("memento: this Hermes version can't add API server routes; update Hermes")
        return
    register_handler("api_server", _wire_api_server)
