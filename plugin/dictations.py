"""A bot's dictations: one row per finished speech-to-text take, as the app wrote it.

The words land in the composer on the device, and the app posts the entry here at that same moment
(ADR 0060). This is the durable copy of the log — the device keeps a mirror and draws every screen from
it — so the pages and totals here exist to fill or repair a mirror, and the totals are what the
Dictation screen counts.

A dictation belongs to one profile: it was heard by one bot, and ``profile`` is what keeps two bots on
one store apart. ``dictation_state`` carries the clock a clear stamped, so a device compares one number
with its mirror instead of enumerating ids.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .store import connect

logger = logging.getLogger(__name__)

FIELDS = ("id", "text", "words", "ms", "at", "device")
# One take's words are a handful of sentences; this is a bound on a body, not a shape a person writes.
MAX_TEXT = 20000
MAX_LIMIT = 200
DEFAULT_LIMIT = 20


class DictationError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _now() -> int:
    return int(time.time() * 1000)


def _profile(value: Optional[str]) -> str:
    return (value or "").strip()


def _open(path: Path) -> sqlite3.Connection:
    conn = connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _whole(value: Any, field: str, default: Optional[int] = None) -> int:
    if value is None and default is not None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DictationError(f"{field} must be a whole number.")
    if int(value) != value:
        raise DictationError(f"{field} must be a whole number.")
    number = int(value)
    if number < 0:
        raise DictationError(f"{field} can't be negative.")
    return number


def _row(row: sqlite3.Row) -> Dict[str, Any]:
    return {field: row[field] for field in FIELDS}


def count_words(text: str) -> int:
    """The app's own count (``countWords`` in ``app/src/lib/dictation-log.ts``): whitespace splits."""
    return len(text.split())


def record(path: Path, profile: Optional[str], body: Dict[str, Any]) -> Dict[str, Any]:
    """Writes one dictation: the entry the app posted when a take's words landed."""
    entry_id = body.get("id")
    if not isinstance(entry_id, str) or not entry_id.strip() or len(entry_id) > 100:
        raise DictationError("A dictation needs an id.")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise DictationError("A dictation needs its words.")
    if len(text) > MAX_TEXT:
        raise DictationError("That dictation is too long to keep.", 413)
    device = body.get("device")
    if device is not None and (not isinstance(device, str) or len(device) > 100):
        raise DictationError("device must be a short string.")
    row = {
        "id": entry_id.strip(),
        "text": text,
        "words": _whole(body.get("words"), "words", count_words(text)),
        "ms": _whole(body.get("ms"), "ms", 0),
        "at": _whole(body.get("at"), "at", _now()),
        "device": device,
    }
    conn = _open(path)
    try:
        # A retry of the same entry finds the row it wrote and changes nothing, which is what makes
        # the app's write safe to fire again after a dropped connection.
        conn.execute(
            "INSERT OR IGNORE INTO dictations (id, profile, text, words, ms, at, device) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (row["id"], _profile(profile), row["text"], row["words"], row["ms"], row["at"], row["device"]),
        )
        found = conn.execute(
            f"SELECT {', '.join(FIELDS)} FROM dictations WHERE id = ? AND profile = ?",
            (row["id"], _profile(profile)),
        ).fetchone()
    finally:
        conn.close()
    return _row(found) if found is not None else row


def rows(
    path: Path,
    profile: Optional[str],
    before: Optional[int] = None,
    limit: int = DEFAULT_LIMIT,
) -> List[Dict[str, Any]]:
    """One profile's dictations, newest first, at most ``limit`` of them.

    ``before`` bounds the page to entries older than itself, which is how a device walks back through
    a history it has none of. A store that isn't there has no dictations rather than an error.
    """
    if not path.exists():
        return []
    page = max(1, min(int(limit), MAX_LIMIT))
    sql = f"SELECT {', '.join(FIELDS)} FROM dictations WHERE profile = ?"
    args: List[Any] = [_profile(profile)]
    if before is not None:
        sql += " AND at < ?"
        args.append(int(before))
    sql += " ORDER BY at DESC, id DESC LIMIT ?"
    args.append(page)
    conn = _open(path)
    try:
        found = conn.execute(sql, args).fetchall()
    finally:
        conn.close()
    return [_row(row) for row in found]


def remove(path: Path, profile: Optional[str], entry_id: str) -> bool:
    """Deletes one dictation; whether there was one to delete."""
    if not path.exists():
        return False
    conn = _open(path)
    try:
        found = conn.execute(
            "DELETE FROM dictations WHERE id = ? AND profile = ?",
            (entry_id, _profile(profile)),
        )
        return found.rowcount > 0
    finally:
        conn.close()


def stamp(path: Path, profile: Optional[str]) -> int:
    """When this profile's log was last cleared, or 0 where it never was."""
    if not path.exists():
        return 0
    conn = _open(path)
    try:
        found = conn.execute(
            "SELECT cleared_at FROM dictation_state WHERE profile = ?", (_profile(profile),)
        ).fetchone()
    finally:
        conn.close()
    return int(found["cleared_at"]) if found is not None else 0


def clear(path: Path, profile: Optional[str]) -> Dict[str, Any]:
    """Takes this profile's whole log away and stamps the clock it went at."""
    at = _now()
    conn = _open(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("DELETE FROM dictations WHERE profile = ?", (_profile(profile),))
            conn.execute(
                "INSERT OR REPLACE INTO dictation_state (profile, cleared_at) VALUES (?, ?)",
                (_profile(profile), at),
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return stats(path, profile)


def stats(path: Path, profile: Optional[str]) -> Dict[str, Any]:
    """The profile's totals, and the fingerprint a device's mirror is reconciled against."""
    empty = {"words": 0, "ms": 0, "count": 0, "newest": None, "oldest": None, "clearedAt": 0}
    if not path.exists():
        return empty
    conn = _open(path)
    try:
        found = conn.execute(
            "SELECT COUNT(*) AS count, COALESCE(SUM(words), 0) AS words, COALESCE(SUM(ms), 0) AS ms, "
            "MAX(at) AS newest, MIN(at) AS oldest FROM dictations WHERE profile = ?",
            (_profile(profile),),
        ).fetchone()
    finally:
        conn.close()
    cleared = stamp(path, profile)
    if found is None:
        return {**empty, "clearedAt": cleared}
    return {
        "words": int(found["words"]),
        "ms": int(found["ms"]),
        "count": int(found["count"]),
        "newest": found["newest"],
        "oldest": found["oldest"],
        "clearedAt": cleared,
    }
