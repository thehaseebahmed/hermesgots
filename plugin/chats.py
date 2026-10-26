"""Gots's chat list, stored on the Hermes server it belongs to.

Each record is ``{at, deleted?, value?}`` keyed by chat id, the same shape the app merges with:
``at`` is the chat's change clock, and the newer record wins, deletions included. Hermes keeps the
transcripts; this keeps what it has no place for (titles the user typed, unsent composer text as
``draftText``, a session's picked permission ``mode``, ...). A value is opaque JSON here; the app
reads those fields back.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, Optional

from . import events
from .store import connect

logger = logging.getLogger(__name__)

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


def by_session(path: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """A chat's record, read by the Hermes session it is about; None when no open chat is that one.

    Two keys exist and a caller holding only a session id can't tell which it has: AFK's record is
    keyed by the session id itself, and one the app made is keyed by the chat id with the session in
    its ``hermesSessionId``. So the cheap read comes first, and the value-keyed one after it — a
    single query against ``chat_session``, SQLite's own reader of the JSON, rather than a walk of
    the whole list, because the delegation sweep asks this per conversation on every look. A closed
    record is no chat: a resolved or discarded session is over, and nothing posts a run of it.
    """
    if not session_id:
        return None
    found = one(path, session_id)
    if found is None:
        found = next(
            (entry for entry in _naming_session(path, session_id) if not closed(entry)), None
        )
    return None if closed(found) else found


def _naming_session(path: Path, session_id: str) -> list[Dict[str, Any]]:
    """Every record whose value names this Hermes session, as ``read`` would decode them.

    ``json_extract`` answers off the index, so only the rows that name the session are decoded;
    which of them counts is still ``closed``'s rule, applied by the caller. A home with no store
    has no chats in it, and reading one never makes one.
    """
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(
            """SELECT at, deleted, value FROM chats
               WHERE json_extract(value, '$.hermesSessionId') = ?""",
            (session_id,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"at": at, "deleted": True} if deleted else {"at": at, "value": json.loads(value)}
        for at, deleted, value in rows
    ]


def pick(provider: Any, model: Any) -> Optional[Dict[str, str]]:
    """``{"provider", "model"}`` when a pick names both halves, or None.

    The rule is the whole of what a pick is, and it is shared by everything that reads or carries
    one — a chat's record, a stored wake batch, a run body — because half a pick is worse than none:
    a run told a model with no provider is refused, while the thread it belongs to would look
    pinned forever and never take another.
    """
    if isinstance(provider, str) and isinstance(model, str) and provider and model:
        return {"provider": provider, "model": model}
    return None


def choice(entry: Optional[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    """The model a chat is pinned to — ``{"provider", "model"}`` — or None when it pins none.

    The app writes the user's pick as ``modelChoice``, and so does a thread's first message: it is
    the one place a session's model is kept, which is what lets a run of that session — AFK's, or a
    subagent's wake — name it instead of taking whatever the profile's Default model is today. A
    half-written pick pins nothing: a run told a model with no provider is refused, not guessed at.
    """
    value = entry.get("value") if isinstance(entry, dict) else None
    held = value.get("modelChoice") if isinstance(value, dict) else None
    if not isinstance(held, dict):
        return None
    return pick(held.get("provider"), held.get("model"))


def pin(path: Path, session_id: str) -> Optional[Dict[str, str]]:
    """The model a session keeps: the pick its own chat record carries, or None.

    Every run after a session's first asks this, so the model it started on is the one it keeps
    however the profile's Default model moves under it — AFK's stages, and the run a finished
    subagent wakes. A session published before records carried a pick, or one whose store can't be
    read, answers None: its run names no model and the host's own answer decides, which is what
    every run did before the pin existed. A pick is never worth losing a run over, so a store this
    can't read is no pin rather than an exception.
    """
    try:
        return choice(by_session(path, session_id))
    except Exception:
        logger.debug("memento: couldn't read %s's pinned model", session_id, exc_info=True)
        return None


def pin_fields(pinned: Optional[Dict[str, str]], *, choice: bool = False) -> Dict[str, Any]:
    """A session's pick as the dict it rides on, or nothing when the session keeps none.

    A run names it ``model`` and ``provider``; a chat record names the pick itself as
    ``modelChoice``. Three seams write that conditional spread otherwise — a run's body in ``afk``,
    a wake's in ``delegation``, and the record ``afk.publish`` makes — and a key they spell
    differently is a pin that never reaches the run it was read for.
    """
    if not pinned:
        return {}
    if choice:
        return {"modelChoice": pinned}
    return {"model": pinned["model"], "provider": pinned["provider"]}


def set_choice(path: Path, chat_id: str, pinned: Dict[str, str]) -> None:
    """Writes ``pinned`` as a chat's ``modelChoice``, keeping the rest of its record.

    This is how a session that has never pinned takes the model of its next send: a message triaged
    onto an older thread is that thread's next send, so the thread stops following the profile's
    Default from here on, exactly as a chat's first send pins it in the app. The record's clock
    moves past whatever it carried, since the merge keeps the newer of the two. A chat with no
    record, or a deleted one, takes nothing: there is nothing to keep the pick for.
    """
    entry = one(path, chat_id)
    value = (entry or {}).get("value")
    if not isinstance(value, dict) or closed(entry):
        return
    merge(path, {chat_id: {"at": _ahead(entry), "value": {**value, "modelChoice": pinned}}})


def _ahead(entry: Dict[str, Any]) -> int:
    """A change clock past the record's own: now, unless that record was written from further ahead.
    """
    held = entry.get("at")
    return max(int(time.time() * 1000), int(held) + 1 if isinstance(held, int) else 0)


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

