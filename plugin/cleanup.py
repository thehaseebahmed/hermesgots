"""Once a day, drops Gots sessions nothing was ever sent in.

A session counts as empty when its chat record shows no activity (``updatedAt`` never moved past
``createdAt``, the app's own test), it is a day old, and Hermes holds no message for it. Anything
that can't be checked is left alone.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

from . import attachments, chats, sessions
from .store import connect, db_path

logger = logging.getLogger(__name__)

GRACE_MS = 24 * 3_600_000


def _has_messages(hermes_home: Path, session_id: str) -> Optional[bool]:
    """Whether Hermes holds a message for the session or a compression child; None if it can't tell."""
    state = hermes_home / "state.db"
    if not state.exists():
        return None
    try:
        with sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
            row = conn.execute(
                """SELECT COUNT(*) FROM messages WHERE session_id = ?
                   OR session_id IN (SELECT id FROM sessions WHERE parent_session_id = ?)""",
                (session_id, session_id),
            ).fetchone()
    except sqlite3.Error:
        return None
    return bool(row and row[0])


def _empty_chats(records: Dict[str, Dict[str, Any]], hermes_home: Path, now: int) -> Dict[str, str]:
    """Chat id → Hermes session id, for each chat nothing happened in."""
    found = {}
    for chat_id, record in records.items():
        value = record.get("value")
        if record.get("deleted") or not isinstance(value, dict):
            continue
        session_id, created, updated = (
            value.get("hermesSessionId"),
            value.get("createdAt"),
            value.get("updatedAt"),
        )
        if not isinstance(session_id, str) or not isinstance(created, (int, float)):
            continue
        if isinstance(updated, (int, float)) and updated > created:
            continue
        if value.get("draftAt") or value.get("draftText"):
            # Saved on purpose: a draft someone is still writing.
            continue
        if value.get("main"):
            # A bot's Main thread is permanent, empty or not.
            continue
        if now - created < GRACE_MS:
            continue
        if _has_messages(hermes_home, session_id) is False:
            found[chat_id] = session_id
    return found


def _project_session_ids(path: Path) -> Dict[str, int]:
    conn = connect(path)
    try:
        return dict(conn.execute("SELECT session_id, created_at FROM project_sessions"))
    finally:
        conn.close()


def sweep(hermes_home: Path, db: Any = None, now: Optional[int] = None) -> Dict[str, int]:
    """One pass: deletes empty sessions. Returns what it did."""
    now = int(time.time() * 1000) if now is None else now
    path = db_path(hermes_home)
    result = {"deleted": 0, "kept": 0}
    if not path.exists():
        return result

    records = chats.read(path)
    empty = _empty_chats(records, hermes_home, now)
    projects = _project_session_ids(path)
    in_chats = {
        (record.get("value") or {}).get("hermesSessionId") for record in records.values()
    }
    # A project session that never reached the chat list is judged by its own age.
    orphans = [
        sid
        for sid, created in projects.items()
        if sid not in in_chats and now - created >= GRACE_MS and _has_messages(hermes_home, sid) is False
    ]

    gone = set()
    tombstones = {}
    for chat_id, sid in [*empty.items(), *((None, sid) for sid in orphans)]:
        if sid in projects:
            try:
                dropped = sessions.remove(path, sid)["removed"]
            except Exception:
                logger.debug("gots: couldn't remove the worktrees of %s", sid, exc_info=True)
                dropped = False
            if not dropped:
                result["kept"] += 1
                continue
        if db is not None and callable(getattr(db, "delete_session", None)):
            try:
                db.delete_session(sid)
            except Exception:
                logger.debug("gots: couldn't delete Hermes session %s", sid, exc_info=True)
        attachments.remove(hermes_home, sid)
        gone.add(sid)
        if chat_id:
            # A tombstone, so the apps drop their copy as well.
            tombstones[chat_id] = {"at": max(now, records[chat_id]["at"] + 1), "deleted": True}
        result["deleted"] += 1
    if tombstones:
        chats.merge(path, tombstones)

    return result


def _seconds_until_midnight() -> float:
    now = datetime.now()
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=5, microsecond=0)
    return (midnight - now).total_seconds()


async def run_daily(adapter: Any, hermes_home: Path) -> None:
    """At the end of each day (the server's local midnight). Covers this profile's home; profiles
    served at ``/p/<profile>`` keep their own, which this doesn't reach."""
    while True:
        await asyncio.sleep(_seconds_until_midnight())
        try:
            db = getattr(adapter, "_session_db", None)
            done = await asyncio.to_thread(sweep, hermes_home, db)
            logger.info("gots: daily cleanup %s", done)
        except Exception:
            logger.warning("gots: daily cleanup failed", exc_info=True)
