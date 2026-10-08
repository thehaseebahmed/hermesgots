"""``GET .../events``: what changed on this server, as Server-Sent Events.

The app keeps one of these open per bot while it is on screen and fetches whatever an event names;
events never carry message text. ``events.py`` writes the rows this reads. Routine changes have no
hook (the cron ledger is written by Hermes's scheduler), so the stream looks at them itself.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import events

logger = logging.getLogger(__name__)

# How often a stream looks for changes made in other processes, how often it pings so proxies and
# tunnels keep it open (Cloudflare cuts a quiet one at 100 s, nginx at 60 s), how often it looks at
# cron, and how long after a turn it watches for Hermes's background title.
TICK_SECONDS = 2
PING_SECONDS = 20
CRON_SECONDS = 4
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

# One fingerprint per profile, shared by every stream open on it: [read at, fingerprint].
_cron: Dict[str, List[Any]] = {}


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


async def cron_mark(profile: str) -> Any:
    """The profile's fingerprint, read at most once per interval however many streams ask."""
    now = time.monotonic()
    cached = _cron.get(profile)
    if cached and now - cached[0] < CRON_SECONDS / 2:
        return cached[1]
    mark = await asyncio.to_thread(_cron_mark)
    _cron[profile] = [now, mark]
    return mark


def chat_session(db: Any, session_id: str) -> str:
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


def sse_headers(adapter: Any, request: Any) -> Dict[str, str]:
    # The CORS middleware only touches a response after its handler returns, by which time a stream
    # has long sent its head, so CORS goes in up front.
    own = getattr(adapter, "_sse_headers", None)
    if callable(own):
        return own(request)
    headers = {"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    cors = getattr(adapter, "_cors_headers_for_origin", None)
    if callable(cors):
        headers.update(cors(request.headers.get("Origin", "")) or {})
    return headers


async def serve(
    web: Any,
    request: Any,
    headers: Dict[str, str],
    path: Path,
    profile: str,
    db: Any,
    cursor: Optional[int],
    version: str,
) -> Any:
    response = web.StreamResponse(status=200, headers=headers)
    await response.prepare(request)
    loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    events.subscribe(loop, wake)
    chat_sessions: Dict[str, str] = {}
    # Chat session -> [title last seen, watched until].
    titles: Dict[str, List[Any]] = {}

    async def send(kind: str, data: Dict[str, Any]) -> None:
        await response.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())

    async def root_session(session_id: str) -> str:
        if session_id not in chat_sessions:
            try:
                chat_sessions[session_id] = await asyncio.to_thread(chat_session, db, session_id)
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
        await send("hello", {"cursor": cursor, "version": version})
        try:
            mark = await cron_mark(profile)
        except Exception:
            mark = None
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
                changed: List[Tuple[str, Optional[str]]] = []
                for row in rows:
                    session_id = row["session_id"]
                    # Runs name the Hermes session of the run, which the app matches itself.
                    if session_id and row["kind"] == "session":
                        session_id = await root_session(session_id)
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
            if loop.time() - cron_checked >= CRON_SECONDS:
                cron_checked = loop.time()
                try:
                    latest_mark = await cron_mark(profile)
                except Exception:
                    latest_mark = mark
                if latest_mark != mark:
                    mark = latest_mark
                    await send("cron", {})
            if loop.time() - pinged >= PING_SECONDS:
                pinged = loop.time()
                await response.write(b": ping\n\n")
            try:
                await asyncio.wait_for(wake.wait(), timeout=TICK_SECONDS)
            except asyncio.TimeoutError:
                pass
    except (ConnectionResetError, ConnectionError):
        # The app went away (backgrounded, offline); it resumes from its cursor.
        pass
    finally:
        events.unsubscribe(loop, wake)
    return response
