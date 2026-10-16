"""Each Gots chat's model history: the model its calls ran on, when it changed.

``post_api_request`` sees every main-loop model call with its session, model and provider. The
plugin appends a row only when that model differs from the session's last row, so a thread can
draw a divider where the model changed. Auxiliary calls (titles, summaries) fire a different hook
and never reach this table.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .store import connect, db_path

logger = logging.getLogger(__name__)

FIELDS = ("at", "model", "provider")

# How long a recorded change is worth keeping: the same window the context table's KEEP_MS uses, kept
# here so the per-call hook doesn't reach into another module's constant for its own prune.
KEEP_MS = 90 * 24 * 60 * 60 * 1000
# The prune can't use the (session_id, at) key, since `at` isn't its leftmost column, so it walks the
# table — and rows old enough to go are rare. Hourly is plenty for rows that expire in 90 days.
PRUNE_EVERY_S = 60 * 60
_pruned_at = 0.0


def normalise(model: str) -> str:
    """Mirrors the app's ``sameModel`` (``app/src/lib/model-match.ts``): case, dots and the vendor
    prefix don't make a new model."""
    return model.strip().lower().replace(".", "-").rsplit("/", 1)[-1]


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def record(**kwargs: Any) -> None:
    """The ``post_api_request`` hook. Runs on every model call, so it never raises."""
    try:
        _record(kwargs)
    except Exception:
        logger.debug("memento: couldn't record model change", exc_info=True)


def _record(kwargs: Dict[str, Any]) -> None:
    if kwargs.get("platform") != "api_server":
        return
    session_id = _text(kwargs.get("session_id"))
    model = _text(kwargs.get("model"))
    if not session_id or not model:
        return
    from hermes_constants import get_hermes_home

    now = int(time.time() * 1000)
    conn = connect(db_path(Path(get_hermes_home())))
    try:
        last = conn.execute(
            "SELECT model FROM model_changes WHERE session_id = ? ORDER BY at DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        if last is None or normalise(last[0]) != normalise(model):
            conn.execute(
                "INSERT OR IGNORE INTO model_changes (session_id, at, model, provider) "
                "VALUES (?, ?, ?, ?)",
                (session_id, now, model, _text(kwargs.get("provider"))),
            )
        _prune(conn, now)
    finally:
        conn.close()


def _prune(conn: Any, now: int) -> None:
    """Drops rows too old for a thread to still show, once an hour rather than on every call."""
    global _pruned_at
    since = time.monotonic()
    if since - _pruned_at < PRUNE_EVERY_S:
        return
    _pruned_at = since
    conn.execute("DELETE FROM model_changes WHERE at < ?", (now - KEEP_MS,))


def read(path: Path, session_id: str, also: Optional[str] = None) -> Optional[List[Dict[str, Any]]]:
    """The rows for the resolved session and the id the app asked with, oldest first.

    Consecutive rows naming the same model collapse to the first, so a compressed chat keeps
    the changes recorded under its parent. An unreadable store answers ``None``, which the app
    reads as "unknown" and keeps the dividers it has: an empty list would mean "no changes".
    """
    if not path.exists():
        return []
    ids = [session_id] + ([also] if also and also != session_id else [])
    marks = ", ".join("?" for _ in ids)
    conn = None
    try:
        conn = connect(path)
        rows = conn.execute(
            f"SELECT {', '.join(FIELDS)} FROM model_changes WHERE session_id IN ({marks}) "
            "ORDER BY at ASC",
            ids,
        ).fetchall()
    except Exception:
        logger.debug("memento: couldn't read model changes", exc_info=True)
        return None
    finally:
        if conn is not None:
            conn.close()
    out: List[Dict[str, Any]] = []
    for at, model, provider in rows:
        if out and normalise(out[-1]["model"]) == normalise(model):
            continue
        out.append({"at": at, "model": model, "provider": provider})
    return out
