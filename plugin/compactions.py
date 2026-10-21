"""When a chat's context was compacted, for its thread to mark.

Hermes compresses a long session by ending it with ``end_reason = 'compression'`` and continuing in a
child, so each ended parent in a chat's lineage is one compaction and its ``ended_at`` is when it
happened. The parent's last call is the context as it stood just before, which the ``context`` table
already keeps per session, so each compaction carries that size and the window it was measured
against. The walk is ``sessions.chat_session``'s, read the other way: only a parent whose turn ended
in compression and a child that continues it rather than forking off it count, since a branch, a
delegation and a tool session share ``parent_session_id`` without being the same conversation.
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
    walked = [session_id]
    try:
        with closing(conn):
            current = session_id
            for _ in range(COMPRESSION_DEPTH):
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
                    found.append({"at": int(row["parent_ended"] * 1000), "session": parent_id})
                current = parent_id
                walked.append(current)
    except sqlite3.Error:
        logger.debug("memento: couldn't read a chat's compactions", exc_info=True)
        return None
    found.sort(key=lambda item: item["at"])
    sizes = _sizes(home, [item["session"] for item in found])
    return [{"at": item["at"], **sizes.get(item["session"], {})} for item in found]


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
