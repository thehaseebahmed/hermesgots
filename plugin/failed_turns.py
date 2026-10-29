"""A turn the host gave up on, taken out of the transcript so a retry carries on from the request.

Hermes ends a turn it could not run with a ``failed_turn`` row and leaves the request above it, so a
resent message would sit under a request and a failure the model never answered. The app's Retry asks
for those two rows (and anything the turn wrote between them) to go before it sends the message
again. Best effort, and only when the row is certain: a store that can't be read or written, a row
that isn't a failed turn or one of another session leaves the transcript alone and the count is 0.
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import closing
from pathlib import Path

logger = logging.getLogger(__name__)

FAILED = "failed_turn"
# Rows a user row is not the request of: a steer goes on the reply it steered, the rest are the host's.
NOT_REQUESTS = ("steer", "hidden", "model_switch")


def clear(home: Path, session_id: str, failed_row: int) -> int:
    """Removes the failed turn that ends in ``failed_row``: its request and what lies after it, up to
    and including the failure. Answers how many rows went."""
    state = home / "state.db"
    if not state.exists():
        return 0
    try:
        with closing(sqlite3.connect(state, timeout=2, isolation_level=None)) as conn:
            failed = conn.execute(
                "SELECT role, display_kind FROM messages WHERE id = ? AND session_id = ?",
                (failed_row, session_id),
            ).fetchone()
            if failed is None or failed[0] != "assistant" or failed[1] != FAILED:
                return 0
            marks = ",".join("?" for _ in NOT_REQUESTS)
            request = conn.execute(
                f"""SELECT id FROM messages
                    WHERE session_id = ? AND role = 'user' AND id < ?
                      AND (display_kind IS NULL OR display_kind NOT IN ({marks}))
                    ORDER BY id DESC LIMIT 1""",
                (session_id, failed_row, *NOT_REQUESTS),
            ).fetchone()
            if request is None:
                return 0
            return conn.execute(
                "DELETE FROM messages WHERE session_id = ? AND id BETWEEN ? AND ?",
                (session_id, request[0], failed_row),
            ).rowcount
    except sqlite3.Error:
        logger.debug("memento: couldn't clear a failed turn out of %s", session_id, exc_info=True)
        return 0
