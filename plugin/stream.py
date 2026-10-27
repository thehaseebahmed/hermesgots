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

# The titles watched per store, for the plugin's life: {path: {"sessions": {id: {title, until}}}}.
# It arms itself off the events ledger, not off a connection: Hermes titles a chat in the background,
# after the device that sent the turn has put the app away as often as not, so a watcher that lived
# inside a stream lost that case. Noted into the ledger, every open stream sends the title within a
# tick, and a device that was away reads it from its own cursor when it returns.
_title_watchers: Dict[str, Dict[str, Any]] = {}


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
        logger.debug("memento: couldn't read a session's title", exc_info=True)
        return None


def watch_titles(path: Path, db: Any, home: Path) -> "asyncio.Task[None]":
    """Starts this store's title reader; the plugin keeps one running for its life.

    The start is stamped here, not in the reader, so a session that moves the moment the plugin
    comes up is watched: only the rows written from now on are armed, and the ledger's history —
    a restart's hour of rows, whose titles landed long ago — is left alone.
    """
    return asyncio.ensure_future(_read_titles(path, db, home, int(time.time() * 1000)))


async def _read_titles(path: Path, db: Any, home: Path, since: int) -> None:
    """Notes the title of every session that moves on this store after ``since``."""
    record = _title_watchers.setdefault(str(path), {"sessions": {}})
    sessions: Dict[str, Dict[str, Any]] = record["sessions"]
    # Session -> the chat it started as, which is the id the app knows a chat by.
    roots: Dict[str, str] = {}
    cursor = await asyncio.to_thread(events.tail_before, path, since)
    while True:
        try:
            rows, _gap = await asyncio.to_thread(events.read_since, path, cursor)
            if rows:
                cursor = rows[-1]["id"]
            for row in rows:
                if row["kind"] == "session" and row["session_id"]:
                    # Compression moves a chat on to a child session, and the title follows the
                    # chat: the event has to name the session the app knows it by, or its
                    # `title` frame matches no chat at all.
                    chat = await asyncio.to_thread(chat_session, home, row["session_id"], roots)
                    until = time.monotonic() + TITLE_WATCH_SECONDS
                    sessions.setdefault(chat, {"title": None, "until": until})
                    sessions[chat]["until"] = until
            now = time.monotonic()
            for session_id in [one for one, watch in sessions.items() if now > watch["until"]]:
                del sessions[session_id]
            titles = await asyncio.gather(*(_title_of(db, one) for one in sessions))
            for session_id, title in zip(list(sessions), titles):
                if title is None:
                    continue
                watch = sessions[session_id]
                if watch["title"] is None:
                    watch["title"] = title
                elif title != watch["title"]:
                    events.note("title", session_id, path, True)
                    # A later title comes with the turn that caused it, which arms a new watch.
                    del sessions[session_id]
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("memento: a title watch failed a pass", exc_info=True)
        await asyncio.sleep(TITLE_TICK_SECONDS)


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
