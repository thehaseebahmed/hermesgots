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

from . import events, push
from .sessions import chat_session

logger = logging.getLogger(__name__)

# How often a stream looks for changes made in other processes, how often it pings so proxies and
# tunnels keep it open (Cloudflare cuts a quiet one at 100 s, nginx at 60 s), how often it looks at
# cron, how often a watched session's title is read, and how long after a session moves it is
# watched: Hermes titles a chat in the background, at its own pace.
TICK_SECONDS = 2
PING_SECONDS = 20
CRON_SECONDS = 4
TITLE_WATCH_SECONDS = 90
TITLE_TICK_SECONDS = 2
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

# One title watch per store path: {session_id: [title last seen, watched until]}, and the task
# reading them. The watch lives outside any one connection on purpose — a watcher inside a
# connection lost the title the moment the device backgrounded the app, and the event it sent was
# never logged, so nothing carried it back. The change is noted into the events ledger instead:
# every open stream sends it within a tick, and a device that was away reads it back from its own
# cursor when it returns.
_watches: Dict[str, Dict[str, List[Any]]] = {}
_watchers: Dict[str, Any] = {}


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


async def _title_of(db: Any, session_id: str) -> Optional[str]:
    """The session's title, or None when it couldn't be read — which is not a title change."""
    get = getattr(db, "get_session_title", None)
    if not callable(get):
        return None
    try:
        return await asyncio.to_thread(get, session_id)
    except Exception:
        return None


async def _watch_titles(path: Path, db: Any) -> None:
    """Reads every session watched on this store until none is, noting the titles that changed."""
    key = str(path)
    try:
        while True:
            watches = _watches.get(key) or {}
            now = time.monotonic()
            for session_id in [one for one, watch in list(watches.items()) if now > watch[1]]:
                del watches[session_id]
            if not watches:
                _watches.pop(key, None)
                return
            for session_id in list(watches):
                watch = watches.get(session_id)
                if watch is None:
                    continue
                title = await _title_of(db, session_id)
                if title is None:
                    continue
                if watch[0] is None:
                    watch[0] = title
                elif title != watch[0]:
                    watch[0] = title
                    events.note("title", session_id, path, True)
            await asyncio.sleep(TITLE_TICK_SECONDS)
    finally:
        _watchers.pop(key, None)
        # A watch that arrived as the task was leaving is still owed its reader.
        if any(time.monotonic() <= watch[1] for watch in (_watches.get(key) or {}).values()):
            _watchers[key] = asyncio.ensure_future(_watch_titles(path, db))


async def watch_title(path: Path, db: Any, session_id: str) -> None:
    """Watches a session's title for a while after the session moves, so the change is noted."""
    key = str(path)
    watches = _watches.setdefault(key, {})
    until = time.monotonic() + TITLE_WATCH_SECONDS
    watching = watches.get(session_id)
    if watching is None:
        watches[session_id] = [None, until]
    else:
        watching[1] = until
    if _watchers.get(key) is None or _watchers[key].done():
        _watchers[key] = asyncio.ensure_future(_watch_titles(path, db))


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
    home: Path,
    cursor: Optional[int],
    version: str,
    device: Optional[str] = None,
) -> Any:
    response = web.StreamResponse(status=200, headers=headers)
    await response.prepare(request)
    loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    events.subscribe(loop, wake)
    chat_sessions: Dict[str, str] = {}

    async def send(kind: str, data: Dict[str, Any]) -> None:
        await response.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())

    async def root_session(session_id: str) -> str:
        if session_id not in chat_sessions:
            try:
                chat_sessions[session_id] = await asyncio.to_thread(
                    chat_session, home, session_id
                )
            except Exception:
                logger.debug("memento: couldn't follow session %s", session_id, exc_info=True)
                return session_id
        return chat_sessions[session_id]

    # A device with a stream open has the app on screen, so it isn't sent pushes.
    presence = push.watching(path, device) if device else None
    if presence:
        presence.__enter__()
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
            # A client that hung up is found out here rather than at the next ping, so a device
            # that closed the app is sent pushes again within a tick.
            transport = request.transport
            if transport is None or transport.is_closing():
                break
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
                        # A session that moved is one Hermes may title in the background; the
                        # watcher notes the change for every device, wherever it is listening.
                        await watch_title(path, db, session_id)
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
        if presence:
            presence.__exit__(None, None, None)
    return response
