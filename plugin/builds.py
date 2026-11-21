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
``on_session_end`` knocks on. A build files its plan before it writes — what will change, how it
will be checked, and whether it waits for the reader's Approve — and a plan that waits holds the
build open until the reader approves it or stops it (G6).

Run: python3 -m unittest plugin.tests.test_canvas_builds -v
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import attachments, canvas_checks, canvases, chats, events, link, notice, sessions
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
# decisions the canvas holds — the memory a build's session writes with ``canvas_memory``
# (canvases.py) and every build's seed reads. Both names are the store's, so a write of either goes
# through the folder's own cap.
DRAFT = canvases.DRAFT
MEMORY = canvases.MEMORY

# A build's phases (step 13 stamps the ones a build passes through while it works). A canvas has at
# most one working build, so `WORKING` is what a read looks for; `stopped` is the reader ending a
# build through its stop route, which publishes nothing and keeps the draft (G6).
PLANNING = "planning"
WAITING = "waiting"
BUILDING = "building"
CHECKING = "checking"
PUBLISHING = "publishing"
PUBLISHED = "published"
FAILED = "failed"
STOPPED = "stopped"

# The phases a build is still working in: one at a time, and the one a canvas's read answers.
WORKING = (PLANNING, WAITING, BUILDING, CHECKING, PUBLISHING)
# The phases a build never comes back from: a version published, a run that failed, or the reader's
# Stop. A finished build is a row of the lane's history, never a canvas's open build.
FINISHED = (PUBLISHED, FAILED, STOPPED)

PHASES = (*WORKING, *FINISHED)

# The one line the lane draws under a working build's phase: what is going on now, said for a reader
# rather than for the record. A finished build has none — its summary is the row's line.
ACTIVITY = {
    PLANNING: "Planning the change",
    WAITING: "Waiting for your approval",
    BUILDING: "Building the page",
    CHECKING: "Checking the rendered page",
    PUBLISHING: "Publishing the version",
}

# The turn the approve route queues on the build's own session once the reader has approved its
# plan: the words the agent is told the approval in, since the build's next turn is what carries it.
APPROVAL = "The plan is approved. Build it."

# The newest summaries a build's seed carries: a build is told what the canvas has lately been asked
# for and what came of it, not its whole history.
SUMMARIES = 5

# How many times a build's draft is checked before it publishes whatever the checks last said
# (ADR 0171): a check round per turn that changed the draft, bounded because each costs four
# renders and a model call. A build never stalls on its checks — at the cap it publishes flagged.
ROUNDS = 3

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
                "SELECT * FROM canvas_builds WHERE session_id = ? AND phase NOT IN (?, ?, ?)",
                (root, *FINISHED),
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
        """SELECT * FROM canvas_builds WHERE canvas_id = ? AND phase NOT IN (?, ?, ?)
           ORDER BY created_at DESC LIMIT 1""",
        (canvas_id, *FINISHED),
    ).fetchone()
    return _build(row) if row else None


def builds_of(path: Path, canvas_id: str) -> List[Dict[str, Any]]:
    """Every build this canvas has had, newest first."""
    if not canvas_id or not path.exists():
        return []
    conn = _open(path)
    try:
        return _builds_in(conn, canvas_id)
    finally:
        conn.close()


def _builds_in(conn: sqlite3.Connection, canvas_id: str) -> List[Dict[str, Any]]:
    """The canvas's builds, newest first, over a connection its caller holds."""
    rows = conn.execute(
        "SELECT * FROM canvas_builds WHERE canvas_id = ? ORDER BY at DESC, rowid DESC",
        (canvas_id,),
    ).fetchall()
    return [_build(row) for row in rows]


def listing(path: Path, canvas_id: str) -> List[Dict[str, Any]]:
    """Every build a canvas has had, newest first, as the lane draws them (G10).

    A finished build carries the request it took, the summary it ended on, what its checks said and
    the version it published; a working one carries its phase and the line saying what it is doing
    now. Each build also carries every visit it made to a phase, in order — except a build the
    record predates, which carries none at all (I6).

    The builds and their visits are read in one snapshot, because they are one answer: a publish
    that landed between the two reads would hand the lane a finished build whose last visit is
    still open — a marker nothing can press — or a build with no visits at all, which reads as one
    written before the record. The 404 is decided before it, from the canvas's own record.
    """
    record = canvases.record(path, canvas_id)
    if record is None:
        raise canvases.CanvasError("There is no such canvas.", 404)
    conn = _open(path)
    try:
        conn.execute("BEGIN")
        builds = _builds_in(conn, canvas_id)
        steps = _steps_in(conn, canvas_id)
    finally:
        conn.close()
    return [_lane_row(one, steps.get(one["id"])) for one in builds]


def _lane_row(one: Dict[str, Any], steps: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """One build as the lane draws it, carrying its visits only where the record holds them."""
    row = {
        "id": one["id"],
        "session": one["session_id"],
        "phase": one["phase"],
        "activity": one.get("activity"),
        "requests": one["requests"],
        "summary": one.get("summary"),
        "flag": one.get("flag"),
        "version": one.get("version"),
        "at": one["at"],
        "created_at": one["created_at"],
    }
    if steps is not None:
        row["steps"] = steps
    return row


def _steps_in(conn: sqlite3.Connection, canvas_id: str) -> Dict[str, List[Dict[str, Any]]]:
    """Every visit this canvas's builds made to a phase, by build, in one statement.

    A visit is ``phase``, ``start``, ``end`` while it is closed and ``flag`` where a check stamped
    one. A build with no rows is absent from the answer rather than answering an empty list: the
    record never saw it, which is not the same as a build that visited nothing (I6).
    """
    rows = conn.execute(
        """SELECT build_id, phase, started_at, ended_at, flag FROM canvas_build_steps
           WHERE build_id IN (SELECT id FROM canvas_builds WHERE canvas_id = ?)
           ORDER BY build_id, ordinal""",
        (canvas_id,),
    ).fetchall()
    found: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        step: Dict[str, Any] = {"phase": row["phase"], "start": row["started_at"]}
        if row["ended_at"] is not None:
            step["end"] = row["ended_at"]
        if row["flag"] is not None:
            step["flag"] = row["flag"]
        found.setdefault(row["build_id"], []).append(step)
    return found


def _public(found: Dict[str, Any]) -> Dict[str, Any]:
    """A working build as the app is told it: its session, where it is, what it is doing, its plan."""
    answer: Dict[str, Any] = {
        "id": found["id"],
        "session": found["session_id"],
        "phase": found["phase"],
        "requests": found["requests"],
    }
    if found.get("activity"):
        answer["activity"] = found["activity"]
    if found.get("plan"):
        answer["plan"] = found["plan"]
    if found.get("wait"):
        answer["wait"] = True
    return answer


def open_map(path: Path) -> Dict[str, Dict[str, Any]]:
    """Every canvas's working build, keyed by canvas, in one read.

    The list a screen draws a record from carries the build working in it, so a phone's edit screen
    — which reads the record and never the document — can draw the phase and the activity line. A
    canvas has at most one working build, so the newest is the one a canvas is drawn with.
    """
    if not path.exists():
        return {}
    conn = _open(path)
    try:
        rows = conn.execute(
            "SELECT * FROM canvas_builds WHERE phase NOT IN (?, ?, ?) ORDER BY created_at DESC",
            FINISHED,
        ).fetchall()
    finally:
        conn.close()
    found: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        build = _build(row)
        found.setdefault(build["canvas_id"], _public(build))
    return found


def waiting(path: Path) -> Dict[str, Dict[str, Any]]:
    """Each canvas chat whose build waits on a plan, as ``runs/live`` reports a wait (step 12).

    Keyed by the canvas chat's session — the one the app polls and a plan's push is about — and
    read in one statement, since every screen asks this on every poll and a canvas's record would
    carry the tile's picture nobody needs here.
    """
    if not path.exists():
        return {}
    conn = _open(path)
    try:
        rows = conn.execute(
            """SELECT c.session_id FROM canvas_builds b JOIN canvases c ON c.id = b.canvas_id
               WHERE b.phase NOT IN (?, ?, ?) AND b.wait = 1""",
            FINISHED,
        ).fetchall()
    finally:
        conn.close()
    return {row[0]: {"kind": "plan"} for row in rows if isinstance(row[0], str) and row[0]}


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
    """Opens a build on a fresh session of its own, and answers it.

    The build and its first visit are one write: a build a reader can see is a build whose lane has
    a step, so no poll lands between them and draws a build the record says nothing happened to.
    """
    build_id = uuid.uuid4().hex
    now = now_ms()
    with canvases._writing(path) as conn:
        conn.execute(
            """INSERT INTO canvas_builds (id, canvas_id, session_id, phase, activity, requests, summary,
                                          run_id, at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)""",
            (
                build_id,
                canvas_id,
                session_of(build_id),
                PLANNING,
                ACTIVITY[PLANNING],
                json.dumps([request] if request else []),
                now,
                now,
            ),
        )
        # The build's first visit opens at the same clock the build is written with, so its lane
        # has a step from the moment the build exists.
        _open_step(conn, build_id, PLANNING, now)
    _note(path, canvas_id)
    return of_canvas(path, canvas_id) or {}


def take(path: Path, build_id: str, request: str) -> None:
    """Adds one request to the build that took it, in the order they came."""
    if not request:
        return
    conn = _open(path)
    try:
        row = conn.execute(
            "SELECT requests FROM canvas_builds WHERE id = ? AND phase NOT IN (?, ?, ?)",
            (build_id, *FINISHED),
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
    """The run this build's session is working on, so a later end can be told from an older one.

    A run starting is the build working again: a build whose plan is filed says it is building,
    and one that has filed none is still planning. A plan that waits keeps saying so, since the
    reader's Approve is what opens the draft — a message sent while it waits only revises it.
    """
    build = _by_id(path, build_id)
    if build is None:
        return
    conn = _open(path)
    try:
        conn.execute(
            "UPDATE canvas_builds SET run_id = ?, at = ? WHERE id = ?", (run_id, now_ms(), build_id)
        )
    finally:
        conn.close()
    if not build.get("wait"):
        _place(path, build_id, BUILDING if build.get("plan") else PLANNING)


def plan(path: Path, build_id: str, args: Dict[str, Any]) -> bool:
    """Files a build's plan — what will change, its checks, and whether it waits — and answers
    whether it waits.

    The plan's words and its wait flag are the build record's: the words are what the lane draws
    while the build waits, and the flag is what holds the draft closed and keeps the build open at
    its run's end. The checks are the folder's own file, written whole like the memory is, since
    the check runner reads them off the folder when the build is checked (step 10). Filing again
    revises the plan, waiting or not (G6).
    """
    changes = args.get("changes")
    if not isinstance(changes, str) or not changes.strip():
        raise canvases.CanvasError("A plan says what will change.")
    checks = args.get("checks") or []
    if not isinstance(checks, list) or not all(
        isinstance(one, dict)
        and isinstance(one.get("name"), str)
        and isinstance(one.get("script"), str)
        for one in checks
    ):
        raise canvases.CanvasError("A plan's checks are named scripts, each a name and a script.")
    wait = args.get("wait")
    if not isinstance(wait, bool):
        raise canvases.CanvasError("A plan says whether it waits for the reader's Approve.")
    build = _by_id(path, build_id)
    if build is None:
        raise canvases.CanvasError("There is no such build.", 404)
    canvases.keep(path, build["canvas_id"], canvases.TESTS, json.dumps(checks))
    phase = WAITING if wait else BUILDING
    # The plan's own columns and the visit it opens land together, inside the canvas module's write
    # lock: a phase must not land without its plan, nor a plan without its phase.
    with canvases._writing(path) as conn:
        conn.execute(
            "UPDATE canvas_builds SET plan = ?, wait = ? WHERE id = ?",
            (changes, 1 if wait else 0, build_id),
        )
        _placed(conn, build_id, phase)
    _note(path, build["canvas_id"])
    return wait


def approve(path: Path, canvas_id: str) -> Optional[Dict[str, Any]]:
    """Approves the waiting plan: the draft opens, and the build is answered as it now is.

    The approval turn itself is queued by the route, on the build's own session, so a run still
    working when the reader approves holds it behind that run. A canvas with no build open, and a
    build whose plan is not waiting, are refused in the module's own words.
    """
    build = of_canvas(path, canvas_id)
    if build is None:
        raise canvases.CanvasError("This canvas has no build open.", 409)
    if not build.get("wait"):
        raise canvases.CanvasError("This build's plan isn't waiting for approval.", 409)
    # The wait and the visit it opens land together: a build must not say it is building without
    # the wait cleared, nor the reverse.
    with canvases._writing(path) as conn:
        # The wait is over, so the marker a push left behind is cleared with it: a plan filed to
        # wait again after this approval is a new wait and new news (step 12).
        conn.execute(
            "UPDATE canvas_builds SET wait = 0, waiting = 0 WHERE id = ?", (build["id"],)
        )
        _placed(conn, build["id"], BUILDING)
    _note(path, canvas_id)
    return _by_id(path, build["id"])


def stop(path: Path, canvas_id: str) -> Optional[Dict[str, Any]]:
    """Ends the build `stopped`: nothing is published and the draft is kept for the next request.

    A waiting plan needs a way out other than Approve, and a build nobody wants is not a failure
    of the host's — the draft stays where the next request takes it up, exactly as a failed run
    leaves it (G6).
    """
    build = of_canvas(path, canvas_id)
    if build is None:
        raise canvases.CanvasError("This canvas has no build open.", 409)
    _phase(path, build["id"], STOPPED, None)
    _note(path, canvas_id)
    return _by_id(path, build["id"])


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
        "at its end. Start by filing a plan with canvas_plan — what will change, how it will be "
        "checked, and whether it waits for the reader's Approve; a clear tweak does not wait. "
        "Write the page with canvas_write and canvas_edit — they land in this canvas's "
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
    # A plan that waits holds the build open: the reader's Approve is what opens the draft, and
    # the build publishes when a run ends after that (G6).
    if build.get("wait"):
        _note_waiting(path, build)
        return
    # A draft that changed since its last check is checked before it publishes: the report is the
    # build's next turn, and the turn that ends on the same draft publishes (ADR 0171).
    document = canvases.draft(path, build["canvas_id"])
    if document and build["rounds"] < ROUNDS and _changed(build, document):
        _checked(path, home, build, document, session_id)
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


def _digest(document: str) -> str:
    """A draft's fingerprint, so a turn that changed nothing is told from one that did."""
    return hashlib.sha256(document.encode("utf-8")).hexdigest()


def _changed(build: Dict[str, Any], document: str) -> bool:
    """Whether the draft has moved since this build last checked it."""
    return build.get("checked") != _digest(document)


def _tests(path: Path, canvas_id: str) -> List[Dict[str, Any]]:
    """The scripts the build's plan filed, as the check runner takes them."""
    said = _read_file(canvases.folder_of(home_of(path), canvas_id) / canvases.TESTS)
    if not said:
        return []
    try:
        found = json.loads(said)
    except ValueError:
        logger.debug("gots: couldn't read %s's tests", canvas_id, exc_info=True)
        return []
    if not isinstance(found, list):
        return []
    return [
        one
        for one in found
        if isinstance(one, dict)
        and isinstance(one.get("name"), str)
        and isinstance(one.get("script"), str)
    ]


def _snapshot(path: Path, canvas_id: str) -> Dict[str, List[Dict[str, Any]]]:
    """The canvas's data as a check answers the page from it: one read-only snapshot by collection.

    The whole-array read the agent's ``canvas_data_read`` makes, grouped the way the harness reads
    a collection. A canvas past that read's bound has no honest snapshot to hand the page, so its
    refusal rides out to ``_checked``, which publishes unchecked rather than testing the page
    against a truncated copy of its data.
    """
    found: Dict[str, List[Dict[str, Any]]] = {}
    for row in canvases.data(path, canvas_id):
        found.setdefault(row["collection"], []).append(row)
    return found


def _takes_images(pinned: Optional[Dict[str, str]]) -> bool:
    """Whether the canvas's model reads images: the app's own rule, where an unknown takes them.

    The catalogue is read through Hermes's own module, imported where it is asked for like every
    other, and a model it doesn't know leaves the unknown reading images — the app's composer does
    the same with an ``imageInput`` it hasn't been told.
    """
    if not pinned:
        return True
    try:
        from agent.models_dev import get_model_capabilities

        found = get_model_capabilities(pinned["provider"], pinned["model"], allow_network=False)
    except Exception:
        logger.debug("gots: couldn't read whether a model reads images", exc_info=True)
        return True
    taken = getattr(found, "supports_vision", None)
    return True if taken is None else bool(taken)


def _data_url(shot: canvas_checks.Shot) -> Optional[str]:
    """One screenshot as the inline image part the API server takes, or None where it can't be read."""
    try:
        data = Path(shot.path).read_bytes()
    except OSError:
        logger.debug("gots: couldn't read a screenshot at %s", shot.path, exc_info=True)
        return None
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def _report_words(report: canvas_checks.CheckReport, images: bool) -> str:
    """What a check's report says: every test, the console, and where the four drawings are."""
    lines = ["The canvas's draft was checked on the rendered page."]
    if report.tests:
        lines += ["", "Tests:"]
        for one in report.tests:
            said = (
                "passed"
                if one.get("ok")
                else f"failed — {one.get('error') or 'the page gave no reason'}"
            )
            lines.append(f"- {one.get('name')}: {said}")
    else:
        lines += ["", "No tests were filed, so the page was only drawn."]
    if report.console:
        lines += ["", "The page's console:"]
        lines += [f"- {one}" for one in report.console]
    if report.shots:
        if images:
            lines += ["", "The four screenshots are attached: 390px and 768px, in light and dark."]
        else:
            lines += ["", "The four screenshots are at:"]
            lines += [f"- {one.width}px, {one.mode}: {one.path}" for one in report.shots]
    lines += [
        "",
        "Fix what failed and write the page again, or reply with the change summary if nothing "
        "needs changing.",
    ]
    return "\n".join(lines)


def _shot_files(report: canvas_checks.CheckReport) -> List[Dict[str, Any]]:
    """The screenshots as the queue's own file rows: a name, a type, a size and where each is."""
    found: List[Dict[str, Any]] = []
    for shot in report.shots:
        try:
            size = Path(shot.path).stat().st_size
        except OSError:
            continue
        found.append(
            {"name": Path(shot.path).name, "type": "image/png", "size": size, "path": shot.path}
        )
    return found


def _stamp(path: Path, build_id: str, number: int, document: str, flag: str) -> None:
    """Records a check round on the build, and the flag it answered on its open checking visit.

    The round's flag is the version's (I5) and the checking step's (G6): the visit stamped is the
    one still open, which is the checking visit this round opened. Both land in one write, so a
    reader is never told what a check found without its marker saying so too.
    """
    now = now_ms()
    with canvases._writing(path) as conn:
        conn.execute(
            "UPDATE canvas_builds SET rounds = ?, checked = ?, flag = ?, at = ? WHERE id = ?",
            (number, _digest(document), flag, now, build_id),
        )
        conn.execute(
            "UPDATE canvas_build_steps SET flag = ? WHERE build_id = ? AND phase = ?"
            " AND ended_at IS NULL",
            (flag, build_id, CHECKING),
        )


def _report_turn(
    path: Path,
    home: Path,
    build: Dict[str, Any],
    report: canvas_checks.CheckReport,
) -> None:
    """Queues a check's report as the build's next turn, the screenshots inline as image parts.

    The turn rides the build's own session, as the approval turn does, and the dispatcher posts it
    as the build's next turn rather than taking it as a request (outbox.py). A model that reads no
    images is given the paths instead, which its own file tools can open.
    """
    from . import outbox

    session = build["session_id"]
    canvas = canvases.record(path, build["canvas_id"]) or {}
    pinned = chats.pin(path, canvas.get("session_id") or "")
    images = _takes_images(pinned)
    words = _report_words(report, images)
    parts: List[Dict[str, Any]] = [{"type": "text", "text": words}]
    if images:
        for shot in report.shots:
            url = _data_url(shot)
            if url:
                parts.append({"type": "image_url", "image_url": {"url": url}})
    content: Any = parts if len(parts) > 1 else words
    body = outbox.clean_body(
        session, {"input": [{"role": "user", "content": content}], **chats.pin_fields(pinned)}
    )
    profile = link.profile_name(home)
    outbox.add(path, session, profile, words, _shot_files(report), body)
    outbox.watch(session, profile, path)


def _checked(
    path: Path, home: Path, build: Dict[str, Any], document: str, session_id: str
) -> None:
    """One check round: the draft drawn the way the app draws it, and what to do with the answer.

    A check that ran posts its report as the build's next turn and leaves the build open; a check
    that couldn't run — no browser, no harness, a layer that refused, a data snapshot past its
    read's bound — stamps ``unchecked`` and publishes, because a build never stalls on its checks.
    """
    number = build["rounds"] + 1
    _place(path, build["id"], CHECKING)
    try:
        snapshot = _snapshot(path, build["canvas_id"])
    except canvases.CanvasError:
        logger.debug("gots: %s's data has no snapshot a check can carry", build["canvas_id"])
        _stamp(path, build["id"], number, document, canvas_checks.UNCHECKED)
        _note(path, build["canvas_id"])
        publish(path, home, build["id"], _summary(session_id))
        return
    folder = attachments.folder(home, build["session_id"]) / f"check-{number}"
    report = canvas_checks.check(document, snapshot, _tests(path, build["canvas_id"]), folder)
    _stamp(path, build["id"], number, document, report.flag)
    _note(path, build["canvas_id"])
    if not report.ran:
        publish(path, home, build["id"], _summary(session_id))
        return
    try:
        _report_turn(path, home, build, report)
    except Exception:
        # The report is what carries the build on. If it can't be queued — a store this can't
        # write, a session this can't name — the build publishes rather than waiting on a turn
        # that is never coming (ADR 0171: a build never stalls on its checks).
        logger.warning("gots: couldn't post a check's report for %s", build["id"], exc_info=True)
        publish(path, home, build["id"], _summary(session_id))


def _first_line(summary: str) -> Optional[str]:
    """A build summary's first line, as a finished build's push carries it: one line, cut."""
    for line in (summary or "").splitlines():
        if line.strip():
            return notice.flatten(line)
    return None


def _mark_waiting(path: Path, build_id: str, waiting: bool) -> None:
    conn = _open(path)
    try:
        conn.execute(
            "UPDATE canvas_builds SET waiting = ? WHERE id = ?", (1 if waiting else 0, build_id)
        )
    finally:
        conn.close()


def _note_waiting(path: Path, build: Dict[str, Any]) -> None:
    """Tells the canvas chat its build waits on a plan, once per wait (step 12).

    The push is the existing ``plan`` kind, about the canvas chat's session — so the bot's and the
    chat's mute both silence it, and a tap opens the canvas through the chat the notice names.
    ``waiting`` reports the same wait to the read every screen polls. A build that waits again
    after an approval is a new wait: the marker the push leaves is cleared with the wait.
    """
    if build.get("waiting"):
        return
    canvas = canvases.record(path, build["canvas_id"]) or {}
    session = canvas.get("session_id")
    if not isinstance(session, str) or not session:
        return
    _mark_waiting(path, build["id"], True)
    from . import push

    push.notify("plan", session, path)


def _pushed_published(path: Path, canvas_id: str, summary: str) -> None:
    """Tells the canvas chat a build finished, once, carrying the summary's first line (step 12)."""
    canvas = canvases.record(path, canvas_id) or {}
    session = canvas.get("session_id")
    if not isinstance(session, str) or not session:
        return
    from . import push

    push.notify("run_done", session, path, body=_first_line(summary))


def publish(path: Path, home: Path, build_id: str, summary: str) -> Optional[Dict[str, Any]]:
    """Publishes the build's draft as one version, and answers what it published.

    The version carries every request the build took, the reply it ended on and what its checks
    said of it, so an undo takes the whole build back and the lane can say what changed without
    reading the transcript. A build that wrote nothing publishes nothing: there is no draft, so
    there is no version to make, and the build still ends — a request that needed no change is not
    a failure.

    The record says ``publishing`` while the version is written, so a lane watching it draws what
    is really happening, and the version it wrote rides the finished record as its number.
    """
    build = _by_id(path, build_id)
    if build is None:
        return None
    document = canvases.draft(path, build["canvas_id"])
    _place(path, build_id, PUBLISHING)
    answer = None
    if document:
        answer = canvases.write(
            path,
            build["canvas_id"],
            document,
            fields={
                "requests": json.dumps(build["requests"]),
                "summary": summary or None,
                "flag": build.get("flag"),
            },
        )
        canvases.drop_draft(path, build["canvas_id"])
    _phase(path, build_id, PUBLISHED, summary or None, (answer or {}).get("version"))
    _note(path, build["canvas_id"])
    _pushed_published(path, build["canvas_id"], summary)
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


def _close_step(conn: sqlite3.Connection, build_id: str, at: int) -> None:
    """Closes the visit a build is in, at ``at`` — the one statement that ends a visit.

    Every window the lane slices is tiled by it (I2): the visit a build leaves ends at the clock the
    next one begins, and a finished build's last visit ends at the clock it ended.
    """
    conn.execute(
        "UPDATE canvas_build_steps SET ended_at = ? WHERE build_id = ? AND ended_at IS NULL",
        (at, build_id),
    )


def _open_step(conn: sqlite3.Connection, build_id: str, phase: str, at: int) -> None:
    """Appends the visit a build just entered, as its next ordinal."""
    ordinal = conn.execute(
        "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM canvas_build_steps WHERE build_id = ?",
        (build_id,),
    ).fetchone()[0]
    conn.execute(
        "INSERT INTO canvas_build_steps (build_id, ordinal, phase, started_at) VALUES (?, ?, ?, ?)",
        (build_id, ordinal, phase, at),
    )


def _phase(
    path: Path,
    build_id: str,
    phase: str,
    summary: Optional[str],
    version: Optional[int] = None,
) -> None:
    """Ends a build in ``phase``: its summary, the version it published, and no activity line.

    A finished build has nothing going on, so the line a working build carries is cleared — its
    summary is what the lane's row says instead. The visit the build was in closes at the same
    clock, since a finished build has no open step (I3), and both land in one write: a build is
    never ended with a visit still open for a reader to draw as the one it is in.
    """
    now = now_ms()
    with canvases._writing(path) as conn:
        conn.execute(
            "UPDATE canvas_builds SET phase = ?, summary = ?, version = COALESCE(?, version), "
            "activity = NULL, at = ? WHERE id = ?",
            (phase, summary, version, now, build_id),
        )
        _close_step(conn, build_id, now)


def _placed(conn: sqlite3.Connection, build_id: str, phase: str) -> None:
    """Stamps where a working build is, the line the lane draws under it, and the step it entered.

    The one writer of a working build's ``phase``, ``activity`` and ``at``, and the one place a
    visit opens or closes. It takes the connection its caller holds — inside the caller's write
    transaction — so the phase, the visit that ended and the visit that began all land together.

    Entering the phase the open visit already holds opens nothing (I4): a run that starts while
    the build already says it is building is the same stretch of work, not a second one.
    """
    row = conn.execute("SELECT phase FROM canvas_builds WHERE id = ?", (build_id,)).fetchone()
    now = now_ms()
    conn.execute(
        "UPDATE canvas_builds SET phase = ?, activity = ?, at = ? WHERE id = ?",
        (phase, ACTIVITY.get(phase), now, build_id),
    )
    if row is None or row[0] == phase:
        return
    _close_step(conn, build_id, now)
    _open_step(conn, build_id, phase, now)


def _place(path: Path, build_id: str, phase: str) -> None:
    """``_placed`` in a write transaction of its own, for a caller that holds none."""
    with canvases._writing(path) as conn:
        _placed(conn, build_id, phase)


def _note(path: Path, canvas_id: str) -> None:
    """A build moved, so every device drawing this canvas hears of it."""
    record = canvases.record(path, canvas_id)
    events.note("canvas", (record or {}).get("session_id"), path, True)


def read(conn: sqlite3.Connection, canvas_id: str) -> Optional[Dict[str, Any]]:
    """What an app is told of this canvas's open build: its session, its phase, its requests, and
    the plan it has filed where one waits.

    The session is what the lane draws while a build runs — a build's work is its own transcript,
    behind the canvas's chat — so the app reads the build's session here rather than guessing one.
    The plan and its wait flag are what the lane draws in the composer's place while the build
    waits, with Approve and Stop beside them (G6). ``conn`` is a connection the caller holds, so a
    canvas's own read answers this without opening a second one.
    """
    found = _of_canvas(conn, canvas_id)
    if found is None:
        return None
    return _public(found)
