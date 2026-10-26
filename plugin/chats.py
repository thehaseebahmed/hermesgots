"""Gots's chat list, stored on the Hermes server it belongs to.

Each record is ``{at, deleted?, value?}`` keyed by chat id, the same shape the app merges with:
``at`` is the chat's change clock, and the newer record wins, deletions included. Hermes keeps the
transcripts; this keeps what it has no place for (titles the user typed, unsent composer text as
``draftText``, a session's picked permission ``mode``, ...). A value is opaque JSON here; the app
reads those fields back.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import events
from .store import connect

MAX_ID_LENGTH = 256
MAX_VALUE_BYTES = 64 * 1024


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


def one(path: Path, chat_id: str) -> Optional[Dict[str, Any]]:
    """One chat's record, read by its id: asking about a single session doesn't cost the whole list."""
    if not chat_id or not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute(
            "SELECT at, deleted, value FROM chats WHERE id = ?", (chat_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    at, deleted, value = row
    return {"at": at, "deleted": True} if deleted else {"at": at, "value": json.loads(value)}


def closed(entry: Optional[Dict[str, Any]]) -> bool:
    """Whether the user is done with a chat: discarded, resolved, or deleted outright.

    The app writes those marks and the chat list carries them to every device, which is why they are
    the answer to "is this session over" for anything running on the host: a merge resolves a session
    by the same reading, and AFK gives a closed session's task back by it.
    """
    if not isinstance(entry, dict):
        return False
    value = entry.get("value")
    return bool(entry.get("deleted")) or (
        isinstance(value, dict) and bool(value.get("discardedAt") or value.get("resolvedAt"))
    )


def _ends_work(entry: Optional[Dict[str, Any]]) -> bool:
    """Whether the user ended a chat so nothing of it should keep working: deleted or discarded.

    Narrower than ``closed``: a resolved session is done with, not abandoned, and its pull request
    merging says nothing about a subagent still reviewing.
    """
    if not isinstance(entry, dict):
        return False
    value = entry.get("value")
    return bool(entry.get("deleted")) or (isinstance(value, dict) and bool(value.get("discardedAt")))


def ending(path: Path, chats: Any) -> List[str]:
    """The sessions of chats an incoming merge is about to delete or discard, read before it lands.

    A tombstone keeps no value, so the session a deleted chat ran under has to be read off the
    record it replaces: its own ``hermesSessionId``, plus the two shapes Gots mints (the chat's id,
    and ``memento-<id>``, which a bot's Main and an AFK session use). Only a record the merge would
    actually take counts, and only a chat that was still open.
    """
    if not isinstance(chats, dict):
        return []
    found: List[str] = []
    for chat_id, entry in chats.items():
        if not isinstance(entry, dict) or not _ends_work(entry):
            continue
        existing = one(path, chat_id)
        at = entry.get("at")
        if existing is None or _ends_work(existing) or not isinstance(at, (int, float)):
            continue
        if at <= existing["at"]:
            continue
        value = existing.get("value")
        named = value.get("hermesSessionId") if isinstance(value, dict) else None
        for session_id in (named, f"memento-{chat_id}", chat_id):
            if isinstance(session_id, str) and session_id and session_id not in found:
                found.append(session_id)
    return found


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

