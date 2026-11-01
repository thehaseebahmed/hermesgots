"""A session's close: the host work that shuts a session down once its user has ended it.

Delete and Discard ask for one — ``POST sessions/{id}/closes`` — and it leaves the request there: the
ask records what the close is for, answers at once, and a thread of its own does the rest (ADR 0075,
in the shape ``clones.spawn`` settled for a clone). The work is ``sessions.remove``, which removes the
session's worktrees and keeps those whose work is uncommitted or unpushed, and ``ship.close``, which
closes each repository's open pull request and deletes its pushed branch on GitHub; the AFK claim the
session held comes off first, the way closing it always did (ADR 0015).

The record is the report. ``sessions.remove`` deletes the session's own row when every tree went, so
this row keeps its own snapshot of the repos — name, root, branch — taken before any of it runs. That
is what lets a close resume after a restart and be read back by a device that never saw the session: a
kept worktree or a refused branch delete is the user's business, and a toast held only in a request
the app was waiting on is a toast the app can lose.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import afk, events, sessions, ship, store

logger = logging.getLogger(__name__)

# How many finished closes stay readable, and for how long: a device that was away when its close
# ended has to find the report, and one that never comes back must not grow the table forever.
KEEP_ROWS = 200
KEEP_MS = 30 * 86_400_000
# How many a device is handed at once: the newest reports, which is what an app that was away needs.
READ_ROWS = 20

_lock = threading.Lock()
# One ask at a time, apart from `_lock`: `start` writes a row and then starts a thread, which takes
# `_lock`, and a plain Lock taken twice in one thread would deadlock it.
_start_lock = threading.Lock()
_resumed: set = set()
_running: set = set()


def _row(row: Any) -> Dict[str, Any]:
    return {
        "session_id": row[0],
        "project_id": row[1],
        "state": row[2],
        "started_at": row[3],
        "ended_at": row[4],
        "repos": json.loads(row[5] or "[]"),
        "removed": bool(row[6]),
        "kept": json.loads(row[7] or "[]"),
        "results": json.loads(row[8] or "[]"),
        "error": row[9] or None,
    }


SELECT = (
    "SELECT session_id, project_id, state, started_at, ended_at, repos, removed, kept, results, error "
    "FROM session_closes"
)


def public(row: Dict[str, Any]) -> Dict[str, Any]:
    """A close as the routes and the app read it: the wire shape, with the repositories as names."""
    return {
        "object": "memento.closing",
        "session_id": row["session_id"],
        "state": row["state"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "repos": [
            repo.get("name") for repo in row["repos"] if isinstance(repo, dict) and repo.get("name")
        ],
        "removed": row["removed"],
        "kept": row["kept"],
        "results": row["results"],
        "error": row["error"],
    }


def read(path: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """The session's close, or None when the host has never been asked to close it."""
    if not path.exists():
        return None
    conn = store.connect(path)
    try:
        row = conn.execute(f"{SELECT} WHERE session_id = ?", (session_id,)).fetchone()
    finally:
        conn.close()
    return _row(row) if row else None


def recent(path: Path, limit: int = READ_ROWS) -> List[Dict[str, Any]]:
    """The closes a device may still be owed, newest first: a session it has already deleted can
    still answer with its report."""
    if not path.exists():
        return []
    conn = store.connect(path)
    try:
        rows = conn.execute(
            f"{SELECT} WHERE state = 'done' ORDER BY ended_at DESC LIMIT ?", (limit,)
        ).fetchall()
    finally:
        conn.close()
    return [_row(row) for row in rows]


def owed(path: Path) -> List[Dict[str, Any]]:
    """Every close a restart left running, oldest first, so the ones nothing resumed go next."""
    if not path.exists():
        return []
    conn = store.connect(path)
    try:
        rows = conn.execute(f"{SELECT} WHERE state = 'closing' ORDER BY started_at ASC").fetchall()
    finally:
        conn.close()
    return [_row(row) for row in rows]


def start(path: Path, home: Path, session_id: str) -> Dict[str, Any]:
    """Records the close and starts it: ``closing``, or ``done`` at once for a session the host holds
    nothing of. A second ask for one already running answers that one."""
    # One ask at a time: two devices pressing the button together must not each write a row with
    # their own start, or the device that lost the race would be told the same close twice.
    with _start_lock:
        existing = read(path, session_id)
        if existing and existing["state"] == "closing":
            if (str(path), session_id) not in _running:
                spawn(path, home, session_id, _snapshot(path, home, existing))
            return existing
        record = sessions.record_for(path, home, session_id)
        now = store.now_ms()
        if not record:
            # Nothing on the host to close: a session that only ever lived in the app ends here, and
            # a second delete of one already closed reads the same way.
            row = {
                "session_id": session_id,
                "project_id": (existing or {}).get("project_id"),
                "state": "done",
                "started_at": now,
                "ended_at": now,
                "repos": (existing or {}).get("repos") or [],
                "removed": True,
                "kept": [],
                "results": [],
                "error": None,
            }
            _write(path, row)
            return row
        row = {
            "session_id": session_id,
            "project_id": record.get("project_id"),
            "state": "closing",
            "started_at": now,
            "ended_at": None,
            "repos": list(record.get("repos") or []),
            "removed": False,
            "kept": [],
            "results": [],
            "error": None,
        }
        _write(path, row)
        spawn(path, home, session_id, record)
        return row


def spawn(path: Path, home: Path, session_id: str, record: Dict[str, Any]) -> None:
    """Runs one close on a thread: git and GitHub take minutes and shouldn't hold a loop worker."""
    key = (str(path), session_id)
    with _lock:
        if key in _running:
            return
        _running.add(key)

    def thread() -> None:
        try:
            run(path, home, session_id, record)
        finally:
            with _lock:
                _running.discard(key)

    threading.Thread(target=thread, name=f"memento-close-{session_id[:8]}", daemon=True).start()


def work(path: Path, home: Path, record: Dict[str, Any]) -> Dict[str, Any]:
    """Does the close's work and answers what it ended with: the one sequence of release, removal and
    pull-request closing that both the thread and an older app's synchronous route run, so the two
    cannot drift."""
    removed = False
    kept: List[Dict[str, Any]] = []
    results: List[Dict[str, Any]] = []
    error: Optional[str] = None
    try:
        # The claim comes off first, the way closing a session always did (ADR 0015).
        try:
            if afk.release_session(home, record):
                afk.wake()
        except Exception:
            logger.warning("memento: couldn't release a closed session's task", exc_info=True)
        # Before the branches go: a tree whose commits are only on its remote branch can still go.
        try:
            gone = sessions.remove(path, record["session_id"])
            removed = bool(gone.get("removed"))
            kept = list(gone.get("kept") or [])
            error = gone.get("error") or None
        except sessions.WorkspaceError as failure:
            error = str(failure) or "Couldn't remove the session's worktrees."
        if removed:
            sessions._clear_cwd(record["session_id"])
        results = ship.close(home, record)
    except Exception as failure:
        logger.warning("memento: a session's close failed", exc_info=True)
        error = error or str(failure) or "Couldn't finish closing the session."
    return {"removed": removed, "kept": kept, "results": results, "error": error}


def run(path: Path, home: Path, session_id: str, record: Dict[str, Any]) -> None:
    """Does one close and writes what it ended with. Never raises: the record is the only place a
    failure can be told, and a close that throws without one is a close nobody hears about."""
    finish(path, session_id, work(path, home, record))


def finish(path: Path, session_id: str, report: Dict[str, Any]) -> None:
    """Writes the report and wakes the app: the row is what a device reads, the note is how an open
    one knows to read it now."""
    try:
        conn = store.connect(path)
        try:
            cursor = conn.execute(
                """UPDATE session_closes
                       SET state = 'done', ended_at = ?, removed = ?, kept = ?, results = ?, error = ?
                       WHERE session_id = ?""",
                (
                    store.now_ms(),
                    int(bool(report.get("removed"))),
                    json.dumps(report.get("kept") or []),
                    json.dumps(report.get("results") or []),
                    report.get("error") or None,
                    session_id,
                ),
            )
            if not cursor.rowcount:
                return
            _prune(conn)
        finally:
            conn.close()
    except Exception:
        logger.warning("memento: couldn't write a session's close report", exc_info=True)
        return
    events.note("closes", session_id, path, True)


def _snapshot(path: Path, home: Path, row: Dict[str, Any]) -> Dict[str, Any]:
    """The record a resumed close runs with: the live session record where it is still there, since
    it carries the task the session worked, and the close's own snapshot where the session is gone."""
    try:
        record = sessions.record_for(path, home, row["session_id"])
    except Exception:
        record = None
    if record:
        return record
    return {
        "session_id": row["session_id"],
        "project_id": row["project_id"],
        "repos": row["repos"],
    }


def resume(home: Path) -> None:
    """Runs again every close a restart left running. Once per home, like a clone's resume; a store
    another writer holds answers nothing rather than raising, and the next boot tries again."""
    path = store.db_path(home)
    with _lock:
        if str(home) in _resumed:
            return
        _resumed.add(str(home))
    try:
        rows = owed(path)
    except Exception:
        logger.debug("memento: couldn't read the session closes to resume", exc_info=True)
        return
    for row in rows:
        spawn(path, home, row["session_id"], _snapshot(path, home, row))


def _write(path: Path, row: Dict[str, Any]) -> None:
    conn = store.connect(path)
    try:
        conn.execute(
            """INSERT INTO session_closes
                   (session_id, project_id, state, started_at, ended_at, repos, removed, kept, results, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (session_id) DO UPDATE SET
                   project_id = excluded.project_id,
                   state = excluded.state,
                   started_at = excluded.started_at,
                   ended_at = excluded.ended_at,
                   repos = excluded.repos,
                   removed = excluded.removed,
                   kept = excluded.kept,
                   results = excluded.results,
                   error = excluded.error""",
            (
                row["session_id"],
                row["project_id"],
                row["state"],
                row["started_at"],
                row["ended_at"],
                json.dumps(row["repos"]),
                int(bool(row["removed"])),
                json.dumps(row["kept"]),
                json.dumps(row["results"]),
                row["error"],
            ),
        )
        if row["state"] == "done":
            _prune(conn)
    finally:
        conn.close()


def _prune(conn: Any) -> None:
    """A report is small and a store is read for years: a count and an age, so a device that comes
    back finds its close and an old one goes."""
    conn.execute(
        "DELETE FROM session_closes WHERE ended_at IS NOT NULL AND ended_at < ?",
        (store.now_ms() - KEEP_MS,),
    )
    conn.execute(
        """DELETE FROM session_closes WHERE session_id IN (
               SELECT session_id FROM session_closes
               ORDER BY started_at DESC LIMIT -1 OFFSET ?)""",
        (KEEP_ROWS,),
    )
