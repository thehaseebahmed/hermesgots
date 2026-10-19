"""AFK: a project's switch for working its own tasks, the sweep that claims one, and its state.

The switch answers one question — is this project left to work its own tasks — and it lives in the
plugin's store rather than on the device that flipped it, because the sweep that works those tasks
runs on the host with the app closed. So the state is read back from the host, per project, and a
project's switch never touches another's.

The sweep reads the project's frontier from GitHub and takes the oldest ready task: assigned to the
host's account and marked with Gots's claim label, created on the repository the first time it's
used (ADR 0012). One task per project at a time — while one is held the sweep has nothing to do —
and a GitHub refusal stops it, leaves the switch on and records the reason the app's sheet shows,
rather than asking again in a loop.

A project that can't be left to work says why instead of offering a switch: it has no GitHub
repository to read tasks from, the host has no GitHub account to read or claim one with, or the
project has been put away. The reason is the host's own answer rather than the app's guess, because
the host is what would do the work — and turning a project on is refused with that reason, so nothing
is ever left half on.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from . import github, tasks
from .store import connect, db_path

logger = logging.getLogger(__name__)

NO_REPOSITORY = "This project has no repository."
NO_GITHUB = "No GitHub account on the server."
# The same words the plugin already refuses an archived project a turn with (sessions._blocked).
ARCHIVED = "This project is archived."

# How often a project left on is swept for work. A GitHub refusal ends that sweep and the next one
# waits for its turn rather than asking again at once.
SWEEP_SECONDS = 180
# What a held task keeps: enough to show it, and to name it in a session's title (sessions.py).
HELD = ("repo", "number", "title", "url", "created_at")

_loop: Optional[asyncio.AbstractEventLoop] = None
_event: Optional["asyncio.Event"] = None
# One claim at a time: the loop's sweep and a wake from a finished session can't both take a task.
_claiming = threading.Lock()
# Homes to sweep besides the one the loop started with. A bot served at /p/<profile> keeps its own
# projects and its own store, which the startup loop can't see; the profile's home is added the
# first time one of its switches is read or written, as the queue watches a profile the same way.
_watched: "set[Path]" = set()
_watch_lock = threading.Lock()


class Refused(Exception):
    """Turning a project on where it can't be left to work. Its reason is the message.

    Its own type, so the route refuses with the reason it was given and nothing else: an error from
    the store is a fault, not the project's answer, and must not reach the app as one.
    """


def reason(
    hermes_home: Path, folders: Iterable[Any], archived: bool = False
) -> Optional[str]:
    """Why this project can't be left to work, or None when it can.

    A project put away is never worked, so it is neither asked about its repositories nor the
    account. One whose checkouts point at no GitHub repository has no tasks to read at all; one with
    a repository needs the host's account to read the tracker and to claim a task on it.
    """
    if archived:
        return ARCHIVED
    if not tasks.repos_of(folders):
        return NO_REPOSITORY
    auth, _ = github.token(hermes_home)
    return None if auth else NO_GITHUB


def state(
    hermes_home: Path, project_id: str, folders: Iterable[Any], archived: bool = False
) -> Dict[str, Any]:
    """The project's switch as the app reads it: whether it's on, and why it can't be.

    An archived project is turned off here if anything had left it on, and reads off whatever
    happens: it was put away, so its switch isn't a setting anything acts on. Writing it off rather
    than only masking it is what keeps a restore from resuming work no one asked for — a project
    archived where this plugin didn't do it (Hermes's own dashboard or CLI) still has its old row.
    """
    why = reason(hermes_home, folders, archived)
    on = is_on(hermes_home, project_id)
    if on and why == ARCHIVED:
        turn_off(hermes_home, project_id)
        on = False
    return {"on": on, "reason": why}


def set_on(
    hermes_home: Path,
    project_id: str,
    folders: Iterable[Any],
    on: bool,
    archived: bool = False,
) -> Dict[str, Any]:
    """Turns the project's AFK on or off, answering its state after the write.

    Turning it on is refused for a project that can't be left to work, the reason being the error's
    message: the app shows that where the switch would be, and nothing is written, so the host never
    holds an on it refused. A project turned on earlier keeps its switch when its reason comes back —
    turning it off is still the user's to do — so the on it answers is the row it holds.
    """
    why = reason(hermes_home, folders, archived)
    if on and why is not None:
        raise Refused(why)
    _write(hermes_home, project_id, on)
    if on:
        # Turning it on is a fresh intent: a refusal recorded before it isn't this switch's answer,
        # and the sweep is asked to look now rather than at the next tick.
        _clear_refusal(hermes_home, project_id)
        wake()
    return {"on": on, "reason": why}


def turn_off(hermes_home: Path, project_id: str) -> None:
    """Turns a project's AFK off: what archiving a project does to it (deleting one forgets it)."""
    _write(hermes_home, project_id, False)


def forget(hermes_home: Path, project_id: str) -> None:
    """Drops a project's switch: the project's record is gone, so there is nothing to leave off."""
    conn = connect(db_path(hermes_home))
    try:
        conn.execute("DELETE FROM project_afk WHERE project_id = ?", (project_id,))
    finally:
        conn.close()


def is_on(hermes_home: Path, project_id: str) -> bool:
    """Whether the project is left to work its own tasks — the host's answer, not a device's."""
    return bool(_one(hermes_home, project_id, "enabled"))


def held(hermes_home: Path, project_id: str) -> Optional[Dict[str, Any]]:
    """The task AFK is holding for the project: one it has claimed and not yet finished with."""
    value = _one(hermes_home, project_id, "task")
    if not isinstance(value, str) or not value:
        return None
    try:
        found = json.loads(value)
    except ValueError:
        return None
    return found if isinstance(found, dict) else None


def refusal(hermes_home: Path, project_id: str) -> Optional[str]:
    """The last reason GitHub refused the sweep, until a sweep gets an answer again."""
    value = _one(hermes_home, project_id, "refusal")
    return value if isinstance(value, str) and value else None


def read(
    hermes_home: Path, project_id: str, folders: Iterable[Any], archived: bool = False
) -> Dict[str, Any]:
    """Everything the app's sheet shows: the switch and its reason, the task held, the last refusal."""
    return {
        **state(hermes_home, project_id, folders, archived),
        "task": held(hermes_home, project_id),
        "refusal": refusal(hermes_home, project_id),
    }


def sweep(
    hermes_home: Path, project_id: str, folders: Iterable[Any], archived: bool = False
) -> Optional[Dict[str, Any]]:
    """Claims the oldest ready task for a project left to work, if it isn't holding one.

    One task per project at a time: while a task is held this does nothing, and the session that
    works it is what lets the next one be taken. A GitHub refusal — no permission to write issues, a
    rate limit, no connection — records its reason and stops this sweep with the switch left on, so
    the sheet says why; the next sweep is the next attempt, not an immediate one.
    """
    if archived or not is_on(hermes_home, project_id):
        return None
    if not tasks.repos_of(folders):
        return read(hermes_home, project_id, folders, archived)
    with _claiming:
        if held(hermes_home, project_id):
            return read(hermes_home, project_id, folders, archived)
        auth, _ = github.token(hermes_home)
        if not auth:
            _refuse(hermes_home, project_id, NO_GITHUB)
            return read(hermes_home, project_id, folders, archived)
        try:
            found = tasks.read(hermes_home, folders)
        except github.GitHubError as error:
            _refuse(hermes_home, project_id, str(error))
            return read(hermes_home, project_id, folders, archived)
        # GitHub answered, so whatever it refused before is stale.
        _clear_refusal(hermes_home, project_id)
        ready = found.get("ready") or []
        if not ready:
            return read(hermes_home, project_id, folders, archived)
        task = ready[0]
        try:
            github.claim_issue(
                task["repo"], task["number"], github.login(auth), tasks.CLAIM_LABEL, auth
            )
        except github.GitHubError as error:
            _refuse(hermes_home, project_id, str(error))
            return read(hermes_home, project_id, folders, archived)
        _hold(hermes_home, project_id, task)
        return read(hermes_home, project_id, folders, archived)


def enabled_projects(hermes_home: Path) -> List[str]:
    """Every project left to work its own tasks, as the host's store holds them."""
    conn = connect(db_path(hermes_home))
    try:
        rows = conn.execute(
            "SELECT project_id FROM project_afk WHERE enabled = 1 ORDER BY project_id"
        ).fetchall()
    finally:
        conn.close()
    return [row[0] for row in rows]


def watch(hermes_home: Path) -> None:
    """Sweeps this home's projects too: a profile's store isn't the one the loop started with."""
    with _watch_lock:
        _watched.add(Path(hermes_home))


def homes(home: Path) -> List[Path]:
    """The home the loop started with, then every one a request has registered, once each."""
    with _watch_lock:
        return list(dict.fromkeys([Path(home), *sorted(_watched)]))


def sweep_all(hermes_home: Path) -> None:
    """Sweeps every project left on; one project's trouble never stops another's."""
    from . import sessions

    for project_id in enabled_projects(hermes_home):
        try:
            project = sessions._project(hermes_home / "projects.db", project_id)
            sweep(
                hermes_home,
                project_id,
                project.folders,
                bool(getattr(project, "archived", False)),
            )
        except Exception:
            logger.debug("memento: couldn't sweep AFK's project %s", project_id, exc_info=True)


async def run(home: Path) -> None:
    """Sweeps the projects left on every ``SWEEP_SECONDS``, and at once when woken, while Hermes runs."""
    global _loop, _event
    _loop = asyncio.get_running_loop()
    _event = asyncio.Event()

    async def sweep_homes() -> None:
        for one in homes(home):
            await asyncio.to_thread(sweep_all, one)

    try:
        # A restart picks up where the store left off: a held task stays held, and an idle project
        # doesn't wait out a whole tick before its first read.
        await sweep_homes()
    except Exception:
        logger.debug("memento: the first AFK sweep failed", exc_info=True)
    while True:
        try:
            await asyncio.wait_for(_event.wait(), SWEEP_SECONDS)
        except asyncio.TimeoutError:
            pass
        _event.clear()
        try:
            await sweep_homes()
        except Exception:
            logger.debug("memento: AFK's sweep failed", exc_info=True)


def wake() -> None:
    """Asks the sweep to look now — a project was turned on, or a session finished — from any thread."""
    loop, event = _loop, _event
    if loop is None or event is None:
        return
    try:
        loop.call_soon_threadsafe(event.set)
    except RuntimeError:
        pass


def after_run(session_id: Any = None, **_kwargs: Any) -> None:
    """The ``on_session_end`` hook: a project session finished, so AFK looks for the next task now.

    Only a project session is AFK's cue — a chat's turn says nothing about its work, and waking a
    sweep for every chat would read GitHub for nothing.
    """
    try:
        from . import sessions

        path, home = sessions._paths()
        if sessions.record_for(path, home, str(session_id or "")):
            wake()
    except Exception:
        logger.debug("memento: couldn't wake AFK's sweep", exc_info=True)


def _hold(hermes_home: Path, project_id: str, task: Dict[str, Any]) -> None:
    """Records the task AFK holds, and clears any refusal: the sweep just succeeded."""
    row = {key: task.get(key) for key in HELD}
    _update(
        hermes_home,
        project_id,
        "task = ?, claimed_at = ?, refusal = NULL, refused_at = NULL",
        (json.dumps(row), int(time.time())),
    )


def _refuse(hermes_home: Path, project_id: str, why: str) -> None:
    """Records why GitHub refused the sweep, which the app's sheet shows under the switch."""
    _update(
        hermes_home,
        project_id,
        "refusal = ?, refused_at = ?",
        (why, int(time.time())),
    )


def _clear_refusal(hermes_home: Path, project_id: str) -> None:
    _update(hermes_home, project_id, "refusal = NULL, refused_at = NULL", ())


def _one(hermes_home: Path, project_id: str, column: str) -> Any:
    """One column of the project's AFK row, or None — the read the app's answers are built from."""
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute(
            f"SELECT {column} FROM project_afk WHERE project_id = ?", (project_id,)
        ).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def _update(hermes_home: Path, project_id: str, assignments: str, values: tuple) -> None:
    """Writes the named fields of the project's AFK row; a project with no row stays without one."""
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            f"UPDATE project_afk SET {assignments} WHERE project_id = ?",
            (*values, project_id),
        )
    finally:
        conn.close()


def _write(hermes_home: Path, project_id: str, on: bool) -> None:
    conn = connect(db_path(hermes_home))
    try:
        # The switch's own columns only: the task it holds and the last refusal are the sweep's.
        conn.execute(
            """INSERT INTO project_afk (project_id, enabled, at) VALUES (?, ?, ?)
               ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, at = excluded.at""",
            (project_id, 1 if on else 0, int(time.time())),
        )
    finally:
        conn.close()
