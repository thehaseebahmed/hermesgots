"""When a chat's context was compacted, for its thread to mark.

A chat's context is compacted in two ways, and the thread marks both. When Hermes rotates a session
(``compression.in_place: false``) it ends it with ``end_reason = 'compression'`` and continues in a
child, so each ended parent in a chat's lineage is one compaction and its ``ended_at`` is when it
happened; the parent's last call is the context as it stood just before, which the ``context`` table
already keeps per session, so each of those carries that size and the window it was measured
against. It compacts in place by default: the same session id goes on, the rows it took away are
soft-archived (``compacted``) and the summary that starts the live context is flagged
``_compressed_summary`` — the only record such a compaction leaves, and one it carries no size for.

The walk is ``sessions.chat_session``'s, read the other way: only a parent whose turn ended in
compression and a child that continues it rather than forking off it count, since a branch, a
delegation and a tool session share ``parent_session_id`` without being the same conversation.
In-place marks are read from the transcript of every session that walk reaches.
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional

from .sessions import COMPRESSION_DEPTH, _forks, _open_state
from .store import connect, db_path

logger = logging.getLogger(__name__)


def read(home: Path, session_id: str) -> Optional[List[Dict[str, Any]]]:
    """The compactions in the chat ``session_id`` is the live end of, oldest first, as ``{ at }`` in ms,
    with ``tokens`` and ``window`` where the plugin recorded the parent's last call.

    A store that can't be read answers ``None``, which the app reads as "unknown" and keeps the
    markers it has: an empty list would mean "nothing was compacted".
    """
    conn = _open_state(home)
    if conn is None:
        return []
    found: List[Dict[str, Any]] = []
    lineage: List[str] = []
    walked = [session_id]
    try:
        with closing(conn):
            current = session_id
            for _ in range(COMPRESSION_DEPTH):
                lineage.append(current)
                row = conn.execute(
                    """SELECT child.parent_session_id AS parent_id,
                              parent.end_reason AS parent_end,
                              parent.ended_at AS parent_ended,
                              child.model_config AS model_config,
                              child.source AS source
                       FROM sessions child LEFT JOIN sessions parent
                         ON parent.id = child.parent_session_id
                       WHERE child.id = ?""",
                    (current,),
                ).fetchone()
                parent_id = row["parent_id"] if row else None
                if (
                    not parent_id
                    or row["parent_end"] != "compression"
                    or parent_id in walked
                    or _forks(row)
                ):
                    break
                if isinstance(row["parent_ended"], (int, float)) and row["parent_ended"] > 0:
                    found.append({"at": _ms(row["parent_ended"]), "session": parent_id})
                current = parent_id
                walked.append(current)
            found.extend(_in_place(conn, lineage))
    except sqlite3.Error:
        logger.debug("memento: couldn't read a chat's compactions", exc_info=True)
        return None
    found.sort(key=lambda item: item["at"])
    sizes = _sizes(home, [item["session"] for item in found if item.get("session")])
    return [{"at": item["at"], **sizes.get(item.get("session") or "", {})} for item in found]


def _ms(seconds: float) -> int:
    """A time in ms the way the app turns a row's own timestamp into one (history.ts: Math.round).

    The mark has to be the row's ms exactly, not a truncated fraction of it: the thread keeps the
    rows the compaction took away when it holds them, and a mark a millisecond under one of those
    still reads as "written after the compaction", which drops the divider one row too early.
    """
    return int(seconds * 1000 + 0.5)


def _in_place(conn: sqlite3.Connection, lineage: List[str]) -> List[Dict[str, Any]]:
    """Each in-place compaction in those sessions' transcripts, as ``{ at }`` in ms.

    ``at`` is the summary row's own time — the moment the compaction ran, which is also the row
    the thread's divider must stand above: the first message written after it. So every device
    draws the same line, wherever it loaded the chat from. The turns the compaction carried run
    right up to that moment (their originals hidden, their copies live) and the summary itself is
    written at it, so all of them sit above the line and the first turn afterwards sits below.
    Dating the mark to the last row the compaction archived instead would drop the divider inside
    the carried turns, minutes of chat before the context was actually compacted.
    """
    found: List[Dict[str, Any]] = []
    table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
    ).fetchone()
    if table is None:
        # A store with no transcript has nowhere to leave an in-place mark.
        return found
    for session in lineage:
        rows = conn.execute(
            "SELECT timestamp FROM messages WHERE session_id = ? AND _compressed_summary = 1"
            " ORDER BY id",
            (session,),
        ).fetchall()
        for row in rows:
            when = row[0]
            if isinstance(when, (int, float)) and when > 0:
                found.append({"at": _ms(when)})
    return found


def _sizes(home: Path, sessions: List[str]) -> Dict[str, Dict[str, int]]:
    """Each session's last prompt size and window, for those the plugin recorded. Best effort: a
    compaction without a size is still a compaction."""
    path = db_path(home)
    if not sessions or not path.exists():
        return {}
    marks = ", ".join("?" for _ in sessions)
    conn = None
    try:
        conn = connect(path)
        rows = conn.execute(
            f"SELECT session_id, prompt_tokens, context_length FROM context "
            f"WHERE session_id IN ({marks})",
            sessions,
        ).fetchall()
    except sqlite3.Error:
        logger.debug("memento: couldn't read context sizes", exc_info=True)
        return {}
    finally:
        if conn is not None:
            conn.close()
    found: Dict[str, Dict[str, int]] = {}
    for session_id, tokens, window in rows:
        size: Dict[str, int] = {}
        if isinstance(tokens, int) and tokens > 0:
            size["tokens"] = tokens
        if isinstance(window, int) and window > 0:
            size["window"] = window
        if size:
            found[session_id] = size
    return found
