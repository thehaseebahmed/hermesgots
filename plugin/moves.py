"""The messages triage sent out of a bot's Main thread, for the Moved markers Main shows in their place.

Each is recorded on the host when the message is queued on its thread, so a marker reads the same on
every device and with the app closed. The message never enters Main's Hermes session, so this table
is the only place Main knows it happened. ``undone`` is the marker's own state, for the way back: a move
keeps what it takes to take it back (the thread's session, the queued item, the message as Main would
have run it) and is open to Undo until the thread's reply to it finishes.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional

from .store import connect

# Where a moved message is in its thread, which is what decides whether Undo is still offered.
QUEUED, RUNNING, STOPPED, REPLIED = "queued", "running", "stopped", "replied"

logger = logging.getLogger(__name__)

MAX_TEXT = 2000
MAX_MOVES = 200


def record(
    path: Path,
    key: Optional[str],
    session_id: str,
    text: str,
    thread: str,
    *,
    thread_session: Optional[str] = None,
    item: Optional[str] = None,
    new: bool = False,
    body: Any = None,
    files: Optional[List[Dict[str, Any]]] = None,
) -> None:
    # The app's message id keys the row, so a repeated ask is one move.
    if not key:
        return
    conn = connect(path)
    try:
        conn.execute(
            """INSERT OR IGNORE INTO main_moves
               (id, session_id, text, thread, at, thread_session, item, new, main_body, files)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                key,
                session_id,
                text[:MAX_TEXT],
                thread,
                int(time.time() * 1000),
                thread_session,
                item,
                1 if new else 0,
                json.dumps(body) if isinstance(body, dict) else None,
                json.dumps(files) if files else None,
            ),
        )
    finally:
        conn.close()


def read(path: Path, session_id: str) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(
            """SELECT id, text, thread, at, undone FROM main_moves
               WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT ?""",
            (session_id, MAX_MOVES),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": id_, "text": text, "thread": thread, "at": at, "undone": bool(undone)}
        for id_, text, thread, at, undone in reversed(rows)
    ]


def get(path: Path, session_id: str, key: str) -> Optional[Dict[str, Any]]:
    """One move with what Undo needs, or None."""
    if not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute(
            """SELECT id, text, thread, thread_session, item, new, main_body, files, undone
               FROM main_moves WHERE id = ? AND session_id = ?""",
            (key, session_id),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    id_, text, thread, thread_session, item, new, main_body, files, undone = row
    return {
        "id": id_,
        "text": text,
        "thread": thread,
        "thread_session": thread_session,
        "item": item,
        "new": bool(new),
        "body": json.loads(main_body) if main_body else None,
        "files": json.loads(files) if files else [],
        "undone": bool(undone),
    }


def mark_undone(path: Path, key: str) -> None:
    conn = connect(path)
    try:
        conn.execute("UPDATE main_moves SET undone = 1 WHERE id = ?", (key,))
    finally:
        conn.close()


def phase(item: Optional[Dict[str, Any]], status: Optional[Dict[str, Any]]) -> str:
    """Where the thread is with a moved message: ``queued`` (not sent yet), ``running`` (its reply is
    being written), ``stopped`` (a reply that was stopped or failed, which never finished) or
    ``replied``. ``item`` is the outbox row, ``status`` the adapter's status of the run it started.
    A row or a run that can't be found is a reply that finished: Undo is only for what can be taken
    back with certainty."""
    if item is None:
        return REPLIED
    if not item.get("run_id"):
        return QUEUED
    value = (status or {}).get("status")
    if value in ("queued", "running", "waiting_for_approval", "stopping"):
        return RUNNING
    if value in ("cancelled", "failed", "interrupted"):
        return STOPPED
    return REPLIED


def undoable(move: Dict[str, Any], where: str) -> bool:
    return not move["undone"] and bool(move.get("body")) and where != REPLIED


def take_from_transcript(home: Path, session_id: str, text: str) -> int:
    """Takes a moved message, and whatever its stopped run wrote after it, out of the thread's
    Hermes transcript. Best effort: Hermes owns that file, so a store that can't be written leaves the
    message there and the count is 0."""
    state = home / "state.db"
    if not state.exists():
        return 0
    try:
        with closing(sqlite3.connect(state, timeout=2, isolation_level=None)) as conn:
            rows = conn.execute(
                """SELECT id, content FROM messages WHERE session_id = ? AND role = 'user'
                   ORDER BY id DESC LIMIT 20""",
                (session_id,),
            ).fetchall()
            first = next((id_ for id_, content in rows if isinstance(content, str) and text in content), None)
            if first is None:
                return 0
            return conn.execute(
                "DELETE FROM messages WHERE session_id = ? AND id >= ?", (session_id, first)
            ).rowcount
    except sqlite3.Error:
        logger.debug("memento: couldn't take a moved message out of %s", session_id, exc_info=True)
        return 0
