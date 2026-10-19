"""AFK's switch, a project's own setting on the host.

The switch answers one question — is this project left to work its own tasks — and it lives in the
plugin's store rather than on the device that flipped it, because the sweep that works those tasks
will run on the host with the app closed. So the state is read back from the host, per project, and a
project's switch never touches another's.

A project that can't be left to work says why instead of offering a switch: it has no GitHub
repository to read tasks from, the host has no GitHub account to read or claim one with, or the
project has been put away. The reason is the host's own answer rather than the app's guess, because
the host is what would do the work — and turning a project on is refused with that reason, so nothing
is ever left half on.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from . import github, tasks
from .store import connect, db_path

NO_REPOSITORY = "This project has no repository."
NO_GITHUB = "No GitHub account on the server."
# The same words the plugin already refuses an archived project a turn with (sessions._blocked).
ARCHIVED = "This project is archived."


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
    """The project's switch as the app reads it: whether it's on, and why it can't be."""
    return {
        "on": is_on(hermes_home, project_id),
        "reason": reason(hermes_home, folders, archived),
    }


def set_on(
    hermes_home: Path,
    project_id: str,
    folders: Iterable[Any],
    on: bool,
    archived: bool = False,
) -> Dict[str, Any]:
    """Turns the project's AFK on or off, answering its state after the write.

    Turning it on is refused for a project that can't be left to work, the reason being the error's
    message: the app shows that where the switch would be, and nothing is written, so a switch shown
    as on is always one the host can act on.
    """
    why = reason(hermes_home, folders, archived)
    if on and why is not None:
        raise ValueError(why)
    _write(hermes_home, project_id, on)
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
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute(
            "SELECT enabled FROM project_afk WHERE project_id = ?", (project_id,)
        ).fetchone()
    finally:
        conn.close()
    return bool(row and row[0])


def _write(hermes_home: Path, project_id: str, on: bool) -> None:
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO project_afk (project_id, enabled, at) VALUES (?, ?, ?)",
            (project_id, 1 if on else 0, int(time.time())),
        )
    finally:
        conn.close()
