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

from .outbox import KEEP_SENT_MS
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
    now = int(time.time() * 1000)
    conn = connect(path)
    try:
        # Undo ends when the outbox forgets the sent item, so older moves keep no body to resend.
        conn.execute(
            "UPDATE main_moves SET main_body = NULL, files = NULL WHERE at < ?", (now - KEEP_SENT_MS,)
        )
        conn.execute(
            """INSERT OR IGNORE INTO main_moves
               (id, session_id, text, thread, at, thread_session, item, new, main_body, files)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                key,
                session_id,
                text[:MAX_TEXT],
                thread,
                now,
                thread_session,
                item,
                1 if new else 0,
                json.dumps(body) if isinstance(body, dict) else None,
                json.dumps(files) if files else None,
            ),
        )
    finally:
        conn.close()


def _select(
    path: Path, session_id: str, key: Optional[str] = None, full: bool = True
) -> List[Dict[str, Any]]:
    """Moves oldest first, each with what Undo needs, or just the one ``key`` names. Without
    ``full`` the stored run body and files aren't loaded: ``body`` then only says whether there is one."""
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(
            f"""SELECT id, text, thread, at, undone, thread_session, item, new,
                      {"main_body, files" if full else "main_body IS NOT NULL, NULL"}
               FROM main_moves WHERE session_id = ? AND (? IS NULL OR id = ?)
               ORDER BY at DESC, rowid DESC LIMIT ?""",
            (session_id, key, key, MAX_MOVES),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": id_,
            "text": text,
            "thread": thread,
            "at": at,
            "undone": bool(undone),
            "thread_session": thread_session,
            "item": item,
            "new": bool(new),
            "body": (json.loads(main_body) if full else True) if main_body else None,
            "files": json.loads(files) if files else [],
        }
        for id_, text, thread, at, undone, thread_session, item, new, main_body, files in reversed(rows)
    ]


def read(path: Path, session_id: str) -> List[Dict[str, Any]]:
    return _select(path, session_id, full=False)


def get(path: Path, session_id: str, key: str) -> Optional[Dict[str, Any]]:
    """One move with what Undo needs, or None."""
    found = _select(path, session_id, key)
    return found[0] if found else None


def public(move: Dict[str, Any], undoable_now: bool) -> Dict[str, Any]:
    """What the app is told of a move: no session, queue item or body, which are the host's."""
    return {
        "id": move["id"],
        "text": move["text"],
        "thread": move["thread"],
        "at": move["at"],
        "undone": move["undone"],
        "undoable": undoable_now,
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
    value = status.get("status") if isinstance(status, dict) else None
    if value in ("queued", "running", "waiting_for_approval", "stopping"):
        return RUNNING
    if value in ("cancelled", "failed", "interrupted"):
        return STOPPED
    return REPLIED


def undoable(move: Dict[str, Any], where: str) -> bool:
    return not move["undone"] and bool(move.get("body")) and where != REPLIED


def take_from_transcript(home: Path, session_id: str, text: str, since_ms: int = 0) -> int:
    """Takes a moved message, and what its stopped run wrote after it, out of the thread's Hermes
    transcript. Best effort, and only when the message is certain: its row is the thread's newest user
    row, holds the text whole (alone, or after an attachment line), and was written once the item was
    sent. A newer message behind it, a row not written yet or a store that can't be written leave the
    transcript alone and the count is 0."""
    state = home / "state.db"
    if not state.exists() or not text:
        return 0
    try:
        with closing(sqlite3.connect(state, timeout=2, isolation_level=None)) as conn:
            last = conn.execute(
                """SELECT id, content, timestamp FROM messages
                   WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1""",
                (session_id,),
            ).fetchone()
            if last is None or not isinstance(last[1], str):
                return 0
            id_, content, at = last
            if content != text and not content.endswith("\n" + text):
                return 0
            if (at or 0) * 1000 < since_ms - 1000:
                return 0
            return conn.execute(
                "DELETE FROM messages WHERE session_id = ? AND id >= ?", (session_id, id_)
            ).rowcount
    except sqlite3.Error:
        logger.debug("gots: couldn't take a moved message out of %s", session_id, exc_info=True)
        return 0
