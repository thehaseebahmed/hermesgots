"""Memento's Hermes plugin.

Adds routes to the API server, so the Memento app (which only talks to the API server, with its key)
can read cron run history from Hermes's execution ledger instead of piecing it together on each
device, keep its chat list on the server (``chats.py``), report each chat's context use
(``context.py``), tell it what changed as it happens (``events.py``), and label its chats as
Memento's. The dashboard half lives in ``dashboard/``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List

from . import chats, context, events
from .store import db_path

logger = logging.getLogger(__name__)

PREFIX = "/api/plugins/memento"
# Memento shows 24 runs per job.
DEFAULT_PER_JOB = 24
MAX_PER_JOB = 200
# The dashboard shows a session's source as its label. /api/sessions only accepts a fixed set of
# sources, so Memento's chats start as the API server's and the plugin relabels them.
SESSION_SOURCE = "memento"
RELABELLED_SOURCES = ("api_server", "unknown")
# The events stream: how often it looks for changes made in other processes, how often it pings so
# proxies and tunnels keep it open (Cloudflare cuts a quiet one at 100 s, nginx at 60 s), how often
# it looks at cron, and how long after a turn it watches for Hermes's background title.
EVENTS_TICK_SECONDS = 2
EVENTS_PING_SECONDS = 20
EVENTS_CRON_SECONDS = 4
TITLE_WATCH_SECONDS = 90
COMPRESSION_DEPTH = 32
CRON_JOB_FIELDS = (
    "id",
    "name",
    "schedule",
    "enabled",
    "state",
    "next_run_at",
    "last_run_at",
    "last_status",
    "last_error",
)


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


def _cron_mark() -> Any:
    """Changes whenever a job or one of its recent runs does. None without cron."""
    try:
        from cron.executions import list_executions
        from cron.jobs import list_jobs
    except ImportError:
        return None
    jobs = [{field: job.get(field) for field in CRON_JOB_FIELDS} for job in list_jobs(include_disabled=True)]
    runs = [
        (row.get("id"), row.get("status"), row.get("delivery_outcome"))
        for row in list_executions(limit=20)
    ]
    return json.dumps([jobs, runs], sort_keys=True, default=str)


def _chat_session(db: Any, session_id: str) -> str:
    """The session a chat started as. Compression moves a chat on to a child session, and Memento
    only knows the first."""
    get = getattr(db, "get_session", None)
    if not callable(get):
        return session_id
    current = session_id
    for _ in range(COMPRESSION_DEPTH):
        row = get(current) or {}
        parent_id = row.get("parent_session_id")
        parent = parent_id and get(parent_id)
        if not parent or parent.get("end_reason") != "compression":
            break
        current = parent_id
    return current


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
                "features": ["cron_runs", "session_label", "chats", "context", "events"],
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
            path = store_path()
            records, changed = await asyncio.to_thread(
                chats.merge, path, (body or {}).get("chats") if isinstance(body, dict) else None
            )
        except chats.InvalidChats as error:
            return _error(web, str(error), 400)
        # Only real changes, or two devices would keep waking each other.
        if changed:
            await asyncio.to_thread(events.note, "chats", None, path, True)
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

    def sse_headers(request: "web.Request") -> Dict[str, str]:
        # The CORS middleware only touches a response after its handler returns, by which time a
        # stream has long sent its head, so CORS goes in up front.
        own = getattr(adapter, "_sse_headers", None)
        if callable(own):
            return own(request)
        headers = {"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        cors = getattr(adapter, "_cors_headers_for_origin", None)
        if callable(cors):
            headers.update(cors(request.headers.get("Origin", "")) or {})
        return headers

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
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        db = await open_db() if callable(open_db) else None

        response = web.StreamResponse(status=200, headers=sse_headers(request))
        await response.prepare(request)
        loop = asyncio.get_running_loop()
        wake = asyncio.Event()
        events.subscribe(loop, wake)
        chat_sessions: Dict[str, str] = {}
        # Chat session -> [title last seen, watched until].
        titles: Dict[str, List[Any]] = {}

        async def send(kind: str, data: Dict[str, Any]) -> None:
            await response.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())

        async def chat_session(session_id: str) -> str:
            if session_id not in chat_sessions:
                try:
                    chat_sessions[session_id] = await asyncio.to_thread(_chat_session, db, session_id)
                except Exception:
                    logger.debug("memento: couldn't follow session %s", session_id, exc_info=True)
                    return session_id
            return chat_sessions[session_id]

        async def title_of(session_id: str) -> Any:
            get = getattr(db, "get_session_title", None)
            if not callable(get):
                return None
            try:
                return await asyncio.to_thread(get, session_id)
            except Exception:
                return None

        try:
            if cursor is None:
                cursor = await asyncio.to_thread(events.latest, path)
            await send("hello", {"cursor": cursor, "version": VERSION})
            try:
                cron_mark = await asyncio.to_thread(_cron_mark)
            except Exception:
                cron_mark = None
            pinged = cron_checked = loop.time()
            while True:
                # Cleared before reading, so a change noted while this pass runs wakes the next.
                wake.clear()
                rows, gap = await asyncio.to_thread(events.read_since, path, cursor)
                if gap:
                    cursor = await asyncio.to_thread(events.latest, path)
                    await send("reset", {"cursor": cursor})
                    rows = []
                if rows:
                    cursor = rows[-1]["id"]
                    changed: List[Any] = []
                    for row in rows:
                        session_id = row["session_id"]
                        if session_id:
                            session_id = await chat_session(session_id)
                        if (row["kind"], session_id) not in changed:
                            changed.append((row["kind"], session_id))
                    for kind, session_id in changed:
                        await send(kind, {"cursor": cursor, **({"session_id": session_id} if session_id else {})})
                        if kind == "session" and session_id:
                            watch = titles.get(session_id) or [await title_of(session_id), 0.0]
                            watch[1] = loop.time() + TITLE_WATCH_SECONDS
                            titles[session_id] = watch
                for session_id, watch in list(titles.items()):
                    if loop.time() > watch[1]:
                        del titles[session_id]
                        continue
                    title = await title_of(session_id)
                    if title != watch[0]:
                        watch[0] = title
                        await send("title", {"session_id": session_id})
                if loop.time() - cron_checked >= EVENTS_CRON_SECONDS:
                    cron_checked = loop.time()
                    try:
                        mark = await asyncio.to_thread(_cron_mark)
                    except Exception:
                        mark = cron_mark
                    if mark != cron_mark:
                        cron_mark = mark
                        await send("cron", {})
                if loop.time() - pinged >= EVENTS_PING_SECONDS:
                    pinged = loop.time()
                    await response.write(b": ping\n\n")
                try:
                    await asyncio.wait_for(wake.wait(), timeout=EVENTS_TICK_SECONDS)
                except asyncio.TimeoutError:
                    pass
        except (ConnectionResetError, ConnectionError):
            # The app went away (backgrounded, offline); it resumes from its cursor.
            pass
        finally:
            events.unsubscribe(loop, wake)
        return response

    app.router.add_get(f"{PREFIX}/info", info)
    app.router.add_get(f"{PREFIX}/events", stream_events)
    app.router.add_get(f"{PREFIX}/chats", list_chats)
    app.router.add_post(f"{PREFIX}/chats", merge_chats)
    app.router.add_get(f"{PREFIX}/cron/runs", cron_runs)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/label", label_session)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/context", session_context)
    logger.info("memento: serving %s on the API server", PREFIX)


def register(ctx) -> None:
    register_hook = getattr(ctx, "register_hook", None)
    if register_hook is not None:
        register_hook("post_api_request", context.record)
        register_hook("post_api_request", events.on_model_call)
        register_hook("pre_llm_call", events.on_turn_start)
        register_hook("pre_tool_call", events.on_tool)
        register_hook("post_tool_call", events.on_tool)
        register_hook("on_session_end", events.on_turn_end)
    register_handler = getattr(ctx, "register_platform_handler", None)
    if register_handler is None:
        logger.warning("memento: this Hermes version can't add API server routes; update Hermes")
        return
    register_handler("api_server", _wire_api_server)
