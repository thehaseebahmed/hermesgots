"""A canvas's builds: one request becomes a build on its own session, published as one version.

A canvas was one long-lived session whose every ``canvas_write`` was a version the reader saw, so a
request's context was the whole chat and a half-built page was published on the way. **Each request
now opens a build** (ADR 0170): a fresh ``canvas-…`` session seeded with the page, the canvas's
memory and the newest build summaries, which writes into a draft in the canvas's folder and
publishes at most one version when its run ends with nothing queued — carrying every request the
build took and its final reply as its summary. A request sent while a build is open joins it. A run
that fails or is interrupted publishes nothing and keeps the draft for the next request.

The canvas's chat record stays the request inbox (its model pin, drafts, start files, mute and the
queue), and the outbox routes its items into builds — so the send path is not rebuilt and no new
request route exists. ``enter`` is the door the outbox knocks on; ``ended`` is the one Hermes's
``on_session_end`` knocks on.

Run: python3 -m unittest plugin.tests.test_canvas_builds -v
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import canvases, events, sessions
from .store import connect, home_of, now_ms

logger = logging.getLogger(__name__)

# The feature `info` advertises where a canvas's requests are builds: an app that predates it keeps
# today's one-session path, so a canvas it made carries no build flag (canvases.create).
FEATURE = "canvas_builds"

# A build's session is named outside `gots-…` (and `memento-…`), which is what keeps it out of every
# chat list, out of the daily sweep and out of progress reminders — the sessions those already
# ignore. The name carries no canvas id on purpose: a build is not a chat of the canvas's.
SESSION_PREFIX = "canvas-"

# The two files a build keeps in a canvas's folder: the page it is writing and the requirements and
# decisions the canvas holds (the memory tool is step 8; the file is read by every build's seed
# either way). Both names are the store's, so a write of either goes through the folder's own cap.
DRAFT = canvases.DRAFT
MEMORY = canvases.MEMORY

# A build's phases (step 13 stamps the ones a build passes through while it works). A canvas has at
# most one open build, so `open` is what a read looks for.
OPEN = "open"
PUBLISHED = "published"
FAILED = "failed"

PHASES = (OPEN, PUBLISHED, FAILED)

# The newest summaries a build's seed carries: a build is told what the canvas has lately been asked
# for and what came of it, not its whole history.
SUMMARIES = 5

# A build's final reply, kept from `post_llm_call` until its run ends: the summary is the reply the
# agent already writes, read here rather than out of the transcript, which a compression or a
# restart would have moved on from. In memory and bounded, like the replies alerts.py keeps for the
# same reason — a restart loses it and the build publishes without a summary rather than a wrong one.
KEEP_REPLIES = 512

_lock = threading.Lock()
_replies: Dict[str, str] = {}


def _open(path: Path) -> sqlite3.Connection:
    conn = connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _build(row: Any) -> Dict[str, Any]:
    """One stored build as this module hands it around."""
    found = dict(row)
    try:
        held = json.loads(found["requests"] or "[]")
    except ValueError:
        held = []
    found["requests"] = held if isinstance(held, list) else []
    return found


def session_of(build_id: str) -> str:
    """The session a build runs on, from its id: one name of its own, never a chat's."""
    return f"{SESSION_PREFIX}{build_id}"


def of_session(path: Path, session_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """The open build whose session this is, or None when it is no build's.

    A run may be keyed on a session compression moved it on to, so the id is resolved to its root
    first, as every other read of a session's canvas is.
    """
    if not isinstance(session_id, str) or not session_id:
        return None
    try:
        root = sessions.chat_session(home_of(path), session_id)
        if not root.startswith(SESSION_PREFIX):
            return None
        conn = _open(path)
        try:
            row = conn.execute(
                "SELECT * FROM canvas_builds WHERE session_id = ? AND phase = ?", (root, OPEN)
            ).fetchone()
        finally:
            conn.close()
        return _build(row) if row else None
    except Exception:
        logger.debug("gots: couldn't resolve a build for %s", session_id, exc_info=True)
        return None


def of_canvas(path: Path, canvas_id: str) -> Optional[Dict[str, Any]]:
    """This canvas's open build, or None when it has none."""
    if not canvas_id or not path.exists():
        return None
    conn = _open(path)
    try:
        return _of_canvas(conn, canvas_id)
    finally:
        conn.close()


def _of_canvas(conn: sqlite3.Connection, canvas_id: str) -> Optional[Dict[str, Any]]:
    """This canvas's open build over a connection the caller holds, or None when it has none."""
    row = conn.execute(
        """SELECT * FROM canvas_builds WHERE canvas_id = ? AND phase = ?
           ORDER BY created_at DESC LIMIT 1""",
        (canvas_id, OPEN),
    ).fetchone()
    return _build(row) if row else None


def builds_of(path: Path, canvas_id: str) -> List[Dict[str, Any]]:
    """Every build this canvas has had, newest first."""
    if not canvas_id or not path.exists():
        return []
    conn = _open(path)
    try:
        rows = conn.execute(
            "SELECT * FROM canvas_builds WHERE canvas_id = ? ORDER BY at DESC, rowid DESC",
            (canvas_id,),
        ).fetchall()
    finally:
        conn.close()
    return [_build(row) for row in rows]


def enter(path: Path, canvas_id: str, request: str) -> Optional[Dict[str, Any]]:
    """The build this request runs on: the canvas's open one, or a new one.

    Called by the outbox as it dispatches a canvas chat's item, so a request sent while a build is
    open joins that build and one sent with no build open starts it. The request is taken by the
    build it joins, since every request a build took rides the version it publishes.
    """
    found = of_canvas(path, canvas_id)
    if found is not None:
        take(path, found["id"], request)
        return found
    return open_build(path, canvas_id, request)


def open_build(path: Path, canvas_id: str, request: str) -> Dict[str, Any]:
    """Opens a build on a fresh session of its own, and answers it."""
    build_id = uuid.uuid4().hex
    now = now_ms()
    conn = _open(path)
    try:
        conn.execute(
            """INSERT INTO canvas_builds (id, canvas_id, session_id, phase, requests, summary, run_id,
                                          at, created_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)""",
            (
                build_id,
                canvas_id,
                session_of(build_id),
                OPEN,
                json.dumps([request] if request else []),
                now,
                now,
            ),
        )
    finally:
        conn.close()
    _note(path, canvas_id)
    return of_canvas(path, canvas_id) or {}


def take(path: Path, build_id: str, request: str) -> None:
    """Adds one request to the build that took it, in the order they came."""
    if not request:
        return
    conn = _open(path)
    try:
        row = conn.execute(
            "SELECT requests FROM canvas_builds WHERE id = ? AND phase = ?", (build_id, OPEN)
        ).fetchone()
        if row is None:
            return
        try:
            held = json.loads(row[0] or "[]")
        except ValueError:
            held = []
        if not isinstance(held, list):
            held = []
        held.append(request)
        conn.execute(
            "UPDATE canvas_builds SET requests = ?, at = ? WHERE id = ?",
            (json.dumps(held), now_ms(), build_id),
        )
    finally:
        conn.close()


def note_run(path: Path, build_id: str, run_id: Optional[str]) -> None:
    """The run this build's session is working on, so a later end can be told from an older one."""
    conn = _open(path)
    try:
        conn.execute(
            "UPDATE canvas_builds SET run_id = ?, at = ? WHERE id = ?", (run_id, now_ms(), build_id)
        )
    finally:
        conn.close()


def seed(path: Path, canvas_id: str) -> str:
    """What a build is told before it starts: the page, the canvas's memory and its newest builds.

    The seed is the run's own ``instructions``, so it is told once per build rather than once per
    turn. The page rides it whole — a build that starts from a summary of the page writes a page
    from a summary — and the memory and the summaries are what the canvas has decided and what it
    has lately been asked for. A canvas with none of them says so rather than sending an empty
    section.
    """
    parts: List[str] = [
        "You are working on a canvas in a build: one request, one session, one version published "
        "at its end. Write the page with canvas_write and canvas_edit — they land in this canvas's "
        "draft, which becomes the version when your run ends — and read what is there with "
        "canvas_read. Nothing you write reaches the reader before then."
    ]
    page = canvases.page(path, canvas_id)
    document = page.get("html") or ""
    opening = f"The canvas is {page.get('title')!r}, at version {page.get('version') or 0}."
    parts.append(
        opening + (f" Its page as it stands:\n\n{document}" if document else " It has no page yet.")
    )
    memory = _read_file(canvases.folder_of(home_of(path), canvas_id) / MEMORY)
    if memory:
        parts.append(f"What this canvas has already decided:\n\n{memory}")
    summaries = [
        one for one in builds_of(path, canvas_id) if one["phase"] == PUBLISHED and one.get("summary")
    ]
    if summaries:
        lines = [f"- {one['summary']}" for one in summaries[:SUMMARIES]]
        parts.append("The newest builds on this canvas:\n" + "\n".join(lines))
    return "\n\n".join(parts)


def _read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8") if path.is_file() else ""
    except OSError:
        logger.debug("gots: couldn't read %s", path, exc_info=True)
        return ""


def reply(**kwargs: Any) -> None:
    """``post_llm_call``: keeps the reply a build's session last gave, as its summary.

    Never raises: it runs inside the model loop, and a hook that raises there costs the turn.
    """
    try:
        session_id = kwargs.get("session_id")
        said = kwargs.get("assistant_response")
        if not isinstance(session_id, str) or not isinstance(said, str) or not said.strip():
            return
        if not session_id.startswith(SESSION_PREFIX):
            return
        with _lock:
            if len(_replies) > KEEP_REPLIES:
                _replies.clear()
            _replies[session_id] = said
    except Exception:
        logger.debug("gots: couldn't keep a build's reply", exc_info=True)


def ended(**kwargs: Any) -> None:
    """``on_session_end``: a build's run is over, so it publishes or fails. Never raises."""
    try:
        _ended(kwargs)
    except Exception:
        logger.debug("gots: a build's end failed", exc_info=True)


def _ended(kwargs: Dict[str, Any]) -> None:
    session_id = kwargs.get("session_id")
    if not isinstance(session_id, str) or not session_id.startswith(SESSION_PREFIX):
        return
    path, home = sessions._paths()
    if not path.exists():
        return
    build = of_session(path, session_id)
    if build is None:
        return
    if not sessions.outcome(**kwargs).finished:
        fail(path, build["id"])
        return
    # A request that arrived while this run worked is the build's next turn rather than a second
    # build, so the build carries on instead of publishing under it.
    if _owed(path, build):
        return
    publish(path, home, build["id"], _summary(session_id))


def _owed(path: Path, build: Dict[str, Any]) -> bool:
    """Whether a request is waiting that this build would take as its next turn."""
    from . import outbox

    canvas = canvases.record(path, build["canvas_id"])
    session = (canvas or {}).get("session_id")
    if session and outbox.head(path, session)[0] is not None:
        return True
    return outbox.head(path, build["session_id"])[0] is not None


def _summary(session_id: str) -> str:
    with _lock:
        return _replies.pop(session_id, "")


def publish(path: Path, home: Path, build_id: str, summary: str) -> Optional[Dict[str, Any]]:
    """Publishes the build's draft as one version, and answers what it published.

    The version carries every request the build took and the reply it ended on, so an undo takes
    the whole build back and the lane can say what changed without reading the transcript. A build
    that wrote nothing publishes nothing: there is no draft, so there is no version to make, and the
    build still ends — a request that needed no change is not a failure.
    """
    build = _by_id(path, build_id)
    if build is None:
        return None
    document = canvases.draft(path, build["canvas_id"])
    answer = None
    if document:
        answer = canvases.write(
            path,
            build["canvas_id"],
            document,
            fields={"requests": json.dumps(build["requests"]), "summary": summary or None},
        )
        canvases.drop_draft(path, build["canvas_id"])
    _phase(path, build_id, PUBLISHED, summary or None)
    _note(path, build["canvas_id"])
    return answer


def fail(path: Path, build_id: str) -> None:
    """Ends a build `failed`: nothing is published and the draft is kept for the next request."""
    build = _by_id(path, build_id)
    if build is None:
        return
    _phase(path, build_id, FAILED, None)
    _note(path, build["canvas_id"])


def _by_id(path: Path, build_id: str) -> Optional[Dict[str, Any]]:
    conn = _open(path)
    try:
        row = conn.execute("SELECT * FROM canvas_builds WHERE id = ?", (build_id,)).fetchone()
    finally:
        conn.close()
    return _build(row) if row else None


def _phase(path: Path, build_id: str, phase: str, summary: Optional[str]) -> None:
    conn = _open(path)
    try:
        conn.execute(
            "UPDATE canvas_builds SET phase = ?, summary = ?, at = ? WHERE id = ?",
            (phase, summary, now_ms(), build_id),
        )
    finally:
        conn.close()


def _note(path: Path, canvas_id: str) -> None:
    """A build moved, so every device drawing this canvas hears of it."""
    record = canvases.record(path, canvas_id)
    events.note("canvas", (record or {}).get("session_id"), path, True)


def read(conn: sqlite3.Connection, canvas_id: str) -> Optional[Dict[str, Any]]:
    """What an app is told of this canvas's open build: its session, its phase and its requests.

    The session is what the lane draws while a build runs — a build's work is its own transcript,
    behind the canvas's chat — so the app reads the build's session here rather than guessing one.
    ``conn`` is a connection the caller holds, so a canvas's own read answers this without opening
    a second one.
    """
    found = _of_canvas(conn, canvas_id)
    if found is None:
        return None
    return {
        "id": found["id"],
        "session": found["session_id"],
        "phase": found["phase"],
        "requests": found["requests"],
    }
