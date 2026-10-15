"""Gots's chat list, stored on the Hermes server it belongs to.

Each record is ``{at, deleted?, value?}`` keyed by chat id, the same shape the app merges with:
``at`` is the chat's change clock, and the newer record wins, deletions included. Hermes keeps the
transcripts; this keeps what it has no place for (titles the user typed, ...).
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict

from . import events
from .store import connect

MAX_ID_LENGTH = 256
MAX_VALUE_BYTES = 16 * 1024


class InvalidChats(ValueError):
    pass


def _records(conn: sqlite3.Connection) -> Dict[str, Dict[str, Any]]:
    records: Dict[str, Dict[str, Any]] = {}
    for chat_id, at, deleted, value in conn.execute("SELECT id, at, deleted, value FROM chats"):
        records[chat_id] = {"at": at, "deleted": True} if deleted else {"at": at, "value": json.loads(value)}
    return records


def _validate(chats: Any) -> list[tuple[str, int, int, str | None]]:
    if not isinstance(chats, dict):
        raise InvalidChats("chats must be an object")
    rows = []
    for chat_id, entry in chats.items():
        if not chat_id or len(chat_id) > MAX_ID_LENGTH:
            raise InvalidChats("Invalid chat id")
        if not isinstance(entry, dict):
            raise InvalidChats(f"Chat {chat_id} must be an object")
        at = entry.get("at")
        if isinstance(at, bool) or not isinstance(at, (int, float)) or at < 0:
            raise InvalidChats(f"Chat {chat_id} needs a change time")
        if entry.get("deleted"):
            rows.append((chat_id, int(at), 1, None))
            continue
        value = entry.get("value")
        if not isinstance(value, dict):
            raise InvalidChats(f"Chat {chat_id} needs a value")
        text = json.dumps(value, separators=(",", ":"))
        if len(text.encode("utf-8")) > MAX_VALUE_BYTES:
            raise InvalidChats(f"Chat {chat_id} is too large")
        rows.append((chat_id, int(at), 0, text))
    return rows


def read(path: Path) -> Dict[str, Dict[str, Any]]:
    if not path.exists():
        return {}
    conn = connect(path)
    try:
        return _records(conn)
    finally:
        conn.close()


def merge(path: Path, chats: Any) -> Dict[str, Dict[str, Any]]:
    """Keeps whichever record is newer, then returns every record so the app can take the rest."""
    rows = _validate(chats)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        before = conn.total_changes
        conn.executemany(
            """INSERT INTO chats (id, at, deleted, value) VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   at = excluded.at, deleted = excluded.deleted, value = excluded.value
               WHERE excluded.at > chats.at""",
            rows,
        )
        changed = conn.total_changes > before
        records = _records(conn)
        conn.execute("COMMIT")
        # Only a merge that changed something is news: two devices merging the same list would
        # otherwise wake each other forever.
        if changed:
            events.note("chats", None, path, True)
        return records
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()

