"""What changed on this Hermes server, for the app's live stream (``GET .../events``).

Hooks and the plugin's own background work note a change as a small row in ``memento.db``: a chat's
session moved on (a model call, a tool, a turn ending), the chat list merged something new, a run
started, ended or began waiting on the user, or a project's clone changed. Rows carry no message
text; the app reacts by fetching what it already fetches. Writing them to the database rather than holding them
in memory means a stream that reconnects picks up where it left off, and a hook running in another
process (a CLI session, an external cron scheduler) still reaches it.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .store import connect, db_path

logger = logging.getLogger(__name__)

KEEP_MS = 60 * 60 * 1000
KEEP_ROWS = 2000
# A tool loop can fire hooks many times a second; the app only needs to hear that something moved.
THROTTLE_SECONDS = 0.25
# API server sessions seen by this process, so tool hooks (which don't name the platform) skip
# Telegram, the CLI and the rest.
API_SESSIONS_MAX = 512

_lock = threading.Lock()
_api_sessions: Dict[str, float] = {}
_last_noted: Dict[Tuple[str, Optional[str]], float] = {}
_waiters: Set[Tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def _remember(session_id: str) -> None:
    with _lock:
        _api_sessions[session_id] = time.monotonic()
        if len(_api_sessions) > API_SESSIONS_MAX:
            for stale in sorted(_api_sessions, key=_api_sessions.get)[: len(_api_sessions) // 2]:
                del _api_sessions[stale]


def _is_api_session(session_id: Optional[str]) -> bool:
    with _lock:
        return bool(session_id) and session_id in _api_sessions


def note(kind: str, session_id: Optional[str] = None, path: Optional[Path] = None, force: bool = False) -> None:
    """Records a change and wakes the streams. Never raises: it runs inside Hermes's hooks."""
    try:
        now = time.monotonic()
        with _lock:
            last = _last_noted.get((kind, session_id), 0.0)
            if not force and now - last < THROTTLE_SECONDS:
                return
            _last_noted[(kind, session_id)] = now
            if len(_last_noted) > API_SESSIONS_MAX:
                _last_noted.clear()
        if path is None:
            # Hooks run inside the turn's profile scope, so this is that profile's home.
            from hermes_constants import get_hermes_home

            path = db_path(Path(get_hermes_home()))
        _write(path, kind, session_id)
    except Exception:
        logger.debug("memento: couldn't note a %s change", kind, exc_info=True)
        return
    wake()


def _write(path: Path, kind: str, session_id: Optional[str]) -> None:
    at = int(time.time() * 1000)
    conn = connect(path)
    try:
        cursor = conn.execute(
            "INSERT INTO events (at, kind, session_id) VALUES (?, ?, ?)", (at, kind, session_id)
        )
        conn.execute(
            "DELETE FROM events WHERE id <= ? OR at < ?", (cursor.lastrowid - KEEP_ROWS, at - KEEP_MS)
        )
    finally:
        conn.close()


def wake() -> None:
    with _lock:
        waiters = list(_waiters)
    for loop, event in waiters:
        try:
            loop.call_soon_threadsafe(event.set)
        except RuntimeError:
            # The loop has closed; its stream is gone.
            pass


def subscribe(loop: asyncio.AbstractEventLoop, event: asyncio.Event) -> None:
    with _lock:
        _waiters.add((loop, event))


def unsubscribe(loop: asyncio.AbstractEventLoop, event: asyncio.Event) -> None:
    with _lock:
        _waiters.discard((loop, event))


def latest(path: Path) -> int:
    """The newest cursor, including rows already pruned."""
    if not path.exists():
        return 0
    conn = connect(path)
    try:
        row = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'events'").fetchone()
    finally:
        conn.close()
    return int(row[0]) if row else 0


def read_since(path: Path, cursor: int, limit: int = 500) -> Tuple[List[Dict[str, Any]], bool]:
    """Rows after ``cursor``, oldest first, and whether some were pruned before they were read."""
    if not path.exists():
        return [], cursor > 0
    conn = connect(path)
    try:
        newest = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'events'").fetchone()
        newest = int(newest[0]) if newest else 0
        oldest = conn.execute("SELECT MIN(id) FROM events").fetchone()[0]
        rows = conn.execute(
            "SELECT id, kind, session_id FROM events WHERE id > ? ORDER BY id LIMIT ?", (cursor, limit)
        ).fetchall()
    finally:
        conn.close()
    # A cursor past the newest row means the database was replaced since.
    gap = cursor > newest or (cursor < newest and (oldest is None or oldest > cursor + 1))
    return [{"id": r[0], "kind": r[1], "session_id": r[2]} for r in rows], gap


# Hooks. Memento only talks to the API server, so other surfaces' sessions are skipped.


def on_turn_start(**kwargs: Any) -> None:
    """``pre_llm_call``: learns which sessions are the API server's, and a turn is running."""
    session_id = _text(kwargs.get("session_id"))
    if session_id and kwargs.get("platform") == "api_server":
        _remember(session_id)
        note("runs", session_id)


def on_model_call(**kwargs: Any) -> None:
    """``post_api_request``: a model call finished, so context use moved."""
    session_id = _text(kwargs.get("session_id"))
    if session_id and kwargs.get("platform") == "api_server":
        _remember(session_id)
        note("session", session_id)


def on_tool(**kwargs: Any) -> None:
    """``pre_tool_call`` / ``post_tool_call``: Hermes saves the turn so far around each tool."""
    session_id = _text(kwargs.get("session_id"))
    if _is_api_session(session_id):
        note("session", session_id)


def on_turn_end(**kwargs: Any) -> None:
    """``on_session_end``: fires after the turn is saved, whatever its outcome."""
    session_id = _text(kwargs.get("session_id"))
    if session_id and (kwargs.get("platform") == "api_server" or _is_api_session(session_id)):
        note("session", session_id, force=True)
        note("runs", session_id, force=True)


def on_approval(**kwargs: Any) -> None:
    """``pre_approval_request`` / ``post_approval_response``: a run began or stopped waiting for the
    user. The hook names no platform, so a session known to be another surface's is skipped."""
    session_id = _text(kwargs.get("session_id"))
    if session_id is None or _is_api_session(session_id):
        note("runs", session_id, force=True)
