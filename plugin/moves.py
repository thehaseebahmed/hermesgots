"""The messages triage sent out of a bot's Main thread, for the Moved markers Main shows in their place.

Each is recorded on the host when the message is queued on its thread, so a marker reads the same on
every device and with the app closed. The message never enters Main's Hermes session, so this table
is the only place Main knows it happened. ``undone`` is the marker's own state, for the way back.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .store import connect

MAX_TEXT = 2000
MAX_MOVES = 200


def record(path: Path, key: Optional[str], session_id: str, text: str, thread: str) -> None:
    # The app's message id keys the row, so a repeated ask is one move.
    if not key:
        return
    conn = connect(path)
    try:
        conn.execute(
            """INSERT OR IGNORE INTO main_moves (id, session_id, text, thread, at)
               VALUES (?, ?, ?, ?, ?)""",
            (key, session_id, text[:MAX_TEXT], thread, int(time.time() * 1000)),
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
