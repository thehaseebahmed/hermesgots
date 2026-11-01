"""A bot's dictations: one row per finished speech-to-text take, as the app wrote it.

The words land in the composer on the device, and the app posts the entry here at that same moment
(ADR 0060). The row carries two texts: `text`, the words that landed after Cleanup, and `heard`, the
same take as the host's speech model wrote it down — the app's sheet shows both, since they differ by
exactly what the cleanup did (ADR 0062). This is the durable copy of the log — the device keeps a
mirror and draws every screen from it — so the pages and totals here exist to fill or repair a mirror,
and the totals are what the Dictation screen counts.

A dictation belongs to one profile: it was heard by one bot, and ``profile`` is what keeps two bots on
one store apart. ``dictation_state`` carries the clock a clear stamped, so a device compares one number
with its mirror instead of enumerating ids.
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from .store import now_ms, open_rows

logger = logging.getLogger(__name__)

FIELDS = ("id", "text", "heard", "level", "cleaned", "provider", "model", "words", "ms", "at", "seen_at")
# One take's words are a handful of sentences; this is a bound on a body, not a shape a person writes.
MAX_TEXT = 20000
MAX_LIMIT = 200
DEFAULT_LIMIT = 20


class DictationLogError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _profile(value: Optional[str]) -> str:
    return (value or "").strip()


def _seen_at(conn: sqlite3.Connection, profile: str) -> int:
    """When this host heard a take: the log's own clock, in the unit it is stamped in.

    Held above the profile's last clear, because a device reads a row at or below that stamp as one
    the clear took away — a take landing in the stamp's own millisecond would otherwise be dropped
    by every mirror that has not seen it yet (ADR 0060).
    """
    cleared = conn.execute(
        "SELECT cleared_at FROM dictation_state WHERE profile = ?", (profile,)
    ).fetchone()
    if cleared is None:
        return now_ms()
    return max(now_ms(), int(cleared["cleared_at"]) + 1)


@contextmanager
def _transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """One write, committed or rolled back whole: a close alone leaves the rollback implicit."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def _whole(value: Any, field: str, default: Optional[int] = None) -> int:
    if value is None and default is not None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DictationLogError(f"{field} must be a whole number.")
    if int(value) != value:
        raise DictationLogError(f"{field} must be a whole number.")
    number = int(value)
    if number < 0:
        raise DictationLogError(f"{field} can't be negative.")
    return number


def _row(row: sqlite3.Row) -> Dict[str, Any]:
    """One row as the app reads it: `at` when the words were said, `seenAt` when the host heard them."""
    entry = {field: row[field] for field in FIELDS if field != "seen_at"}
    entry["cleaned"] = bool(entry.get("cleaned"))
    for empty in ("heard", "level", "provider", "model"):
        if not entry.get(empty):
            entry.pop(empty, None)
    entry["seenAt"] = row["seen_at"]
    return entry


def count_words(text: str) -> int:
    """The app's own count (``countWords`` in ``app/src/lib/dictation-log.ts``): whitespace splits."""
    return len(text.split())


def _heard(value: Any) -> Optional[str]:
    """The words as the host heard them, or None where this host can't keep them (ADR 0062)."""
    if not isinstance(value, str):
        return None
    heard = value.strip()
    if not heard or len(heard) > MAX_TEXT:
        return None
    return heard


def _named(value: Any, bound: int = 60) -> Optional[str]:
    """A name the host answered — a level, a provider, a model — or None where it named none."""
    if not isinstance(value, str):
        return None
    named = " ".join(value.split())
    return named[:bound] if named else None


def record(path: Path, profile: Optional[str], body: Dict[str, Any]) -> Dict[str, Any]:
    """Writes one dictation: the entry the app posted when a take's words landed."""
    entry_id = body.get("id")
    if not isinstance(entry_id, str) or not entry_id.strip() or len(entry_id) > 100:
        raise DictationLogError("A dictation needs an id.")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise DictationLogError("A dictation needs its words.")
    if len(text) > MAX_TEXT:
        raise DictationLogError("That dictation is too long to keep.", 413)
    row = {
        "id": entry_id.strip(),
        "text": text,
        "heard": _heard(body.get("heard")),
        "level": _named(body.get("level")),
        "cleaned": 1 if body.get("cleaned") is True else 0,
        "provider": _named(body.get("provider")),
        "model": _named(body.get("model")),
        "words": _whole(body.get("words"), "words", count_words(text)),
        "ms": _whole(body.get("ms"), "ms", 0),
        "at": _whole(body.get("at"), "at", now_ms()),
    }
    name = _profile(profile)
    conn = open_rows(path)
    try:
        with _transaction(conn):
            seen_at = _seen_at(conn, name)
            # A take cannot have been said after the host heard it: a device clock running ahead is
            # clamped rather than trusted, so nothing here claims a time after this machine's.
            if row["at"] > seen_at:
                row["at"] = seen_at
            conn.execute(
                "INSERT OR IGNORE INTO dictations "
                "(id, profile, text, heard, level, cleaned, provider, model, words, ms, at, seen_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row["id"],
                    name,
                    row["text"],
                    row["heard"],
                    row["level"],
                    row["cleaned"],
                    row["provider"],
                    row["model"],
                    row["words"],
                    row["ms"],
                    row["at"],
                    seen_at,
                ),
            )
            found = conn.execute(
                f"SELECT {', '.join(FIELDS)} FROM dictations WHERE id = ? AND profile = ?",
                (row["id"], name),
            ).fetchone()
    finally:
        conn.close()
    if found is None:
        raise DictationLogError("That dictation could not be stored.", 500)
    return _row(found)


def rows(
    path: Path,
    profile: Optional[str],
    before: Optional[int] = None,
    before_id: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
) -> List[Dict[str, Any]]:
    """One profile's dictations, newest first, at most ``limit`` of them.

    ``before`` with ``before_id`` is the cursor: the last row a caller already has. Both are needed
    because two takes can share a millisecond — a host clock coarse enough to tie, or rows written by
    an older build — and a bound on the time alone would skip every row tied with it, which is a take
    a device could then never reach. A store that isn't there has no dictations rather than an error.
    """
    if not path.exists():
        return []
    page = max(1, min(int(limit), MAX_LIMIT))
    sql = f"SELECT {', '.join(FIELDS)} FROM dictations WHERE profile = ?"
    args: List[Any] = [_profile(profile)]
    if before is not None and before_id is not None:
        sql += " AND (seen_at < ? OR (seen_at = ? AND id < ?))"
        args.extend([int(before), int(before), before_id])
    elif before is not None:
        sql += " AND seen_at < ?"
        args.append(int(before))
    sql += " ORDER BY seen_at DESC, id DESC LIMIT ?"
    args.append(page)
    conn = open_rows(path)
    try:
        found = conn.execute(sql, args).fetchall()
    finally:
        conn.close()
    return [_row(row) for row in found]


def remove(path: Path, profile: Optional[str], entry_id: str) -> bool:
    """Deletes one dictation; whether there was one to delete."""
    if not path.exists():
        return False
    conn = open_rows(path)
    try:
        found = conn.execute(
            "DELETE FROM dictations WHERE id = ? AND profile = ?",
            (entry_id, _profile(profile)),
        )
        return found.rowcount > 0
    finally:
        conn.close()


def _totals(conn: sqlite3.Connection, profile: str) -> Dict[str, Any]:
    """One profile's totals and clear stamp, off a connection a caller already holds.

    Both reads are on the same store, so a caller that has just written to it — or is about to answer
    with what a clear left — opens it once rather than once per question.
    """
    found = conn.execute(
        "SELECT COUNT(*) AS count, COALESCE(SUM(words), 0) AS words, COALESCE(SUM(ms), 0) AS ms, "
        "MAX(seen_at) AS newest, MIN(seen_at) AS oldest FROM dictations WHERE profile = ?",
        (profile,),
    ).fetchone()
    cleared = conn.execute(
        "SELECT cleared_at FROM dictation_state WHERE profile = ?", (profile,)
    ).fetchone()
    # An aggregate over no rows still answers one row, so there is no empty case to answer for.
    return {
        "words": int(found["words"]),
        "ms": int(found["ms"]),
        "count": int(found["count"]),
        "newest": found["newest"],
        "oldest": found["oldest"],
        "clearedAt": int(cleared["cleared_at"]) if cleared is not None else 0,
    }


def clear(path: Path, profile: Optional[str]) -> Dict[str, Any]:
    """Takes this profile's whole log away, stamps the clock it went at, and answers what is left."""
    name = _profile(profile)
    conn = open_rows(path)
    try:
        with _transaction(conn):
            conn.execute("DELETE FROM dictations WHERE profile = ?", (name,))
            conn.execute(
                "INSERT OR REPLACE INTO dictation_state (profile, cleared_at) VALUES (?, ?)",
                (name, now_ms()),
            )
        return _totals(conn, name)
    finally:
        conn.close()


def stats(path: Path, profile: Optional[str]) -> Dict[str, Any]:
    """The profile's totals, and the fingerprint a device's mirror is reconciled against."""
    if not path.exists():
        return {"words": 0, "ms": 0, "count": 0, "newest": None, "oldest": None, "clearedAt": 0}
    conn = open_rows(path)
    try:
        return _totals(conn, _profile(profile))
    finally:
        conn.close()
