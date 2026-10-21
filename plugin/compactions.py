"""When a chat's context was compacted, for its thread to mark.

Hermes compresses a long session by ending it with ``end_reason = 'compression'`` and continuing in a
child, so each ended parent in a chat's lineage is one compaction and its ``ended_at`` is when it
happened. The walk is ``sessions.chat_session``'s, read the other way: only a parent whose turn ended
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

logger = logging.getLogger(__name__)


def read(home: Path, session_id: str) -> Optional[List[Dict[str, Any]]]:
    """The compactions in the chat ``session_id`` is the live end of, oldest first, as ``{ at }`` in ms.

    A store that can't be read answers ``None``, which the app reads as "unknown" and keeps the
    markers it has: an empty list would mean "nothing was compacted".
    """
    conn = _open_state(home)
    if conn is None:
        return []
    found: List[int] = []
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
                    found.append(int(row["parent_ended"] * 1000))
                current = parent_id
                walked.append(current)
    except sqlite3.Error:
        logger.debug("memento: couldn't read a chat's compactions", exc_info=True)
        return None
    return [{"at": at} for at in sorted(found)]
