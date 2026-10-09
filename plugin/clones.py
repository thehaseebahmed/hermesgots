"""Projects whose GitHub repos are still being cloned, or whose clone failed.

Creating a project answers at once and clones on a background thread, so it carries on with the app
closed. Until every repo is in, the project is a row in ``memento.db``'s ``project_clones``, not in
Hermes's ``projects.db``: a project there is always whole, so a session can never get a worktree in
only some of its repos. The last clone creates the real project and drops the row. A failed clone
removes the folder and keeps the row with its error until the user retries or removes it. A restart
mid-clone clones again from scratch (``resume``).
"""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import events, github, projects, push
from .store import connect, db_path

logger = logging.getLogger(__name__)

ID_PREFIX = "pending-"

_lock = threading.Lock()
_running: Dict[tuple, threading.Event] = {}
_resumed: set = set()


def is_pending_id(project_id: str) -> bool:
    return project_id.startswith(ID_PREFIX)


def _folder(hermes_home: Path, slug: str) -> Path:
    return hermes_home / "projects" / slug


def _row(row: tuple) -> Dict[str, Any]:
    slug, name, description, repos, status, error, created_at = row
    return {
        "slug": slug,
        "name": name,
        "description": description,
        "repos": json.loads(repos),
        "status": status,
        "error": error,
        "created_at": created_at,
    }


_COLUMNS = "slug, name, description, repos, status, error, created_at"


def _all(hermes_home: Path) -> List[Dict[str, Any]]:
    conn = connect(db_path(hermes_home))
    try:
        return [
            _row(row)
            for row in conn.execute(f"SELECT {_COLUMNS} FROM project_clones ORDER BY created_at DESC")
        ]
    finally:
        conn.close()


def _get(hermes_home: Path, slug: str) -> Optional[Dict[str, Any]]:
    conn = connect(db_path(hermes_home))
    try:
        found = conn.execute(f"SELECT {_COLUMNS} FROM project_clones WHERE slug = ?", (slug,)).fetchone()
        return _row(found) if found else None
    finally:
        conn.close()


def _update(hermes_home: Path, slug: str, **fields: Any) -> None:
    if "repos" in fields:
        fields["repos"] = json.dumps(fields["repos"])
    fields["updated_at"] = int(time.time())
    assignments = ", ".join(f"{column} = ?" for column in fields)
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(f"UPDATE project_clones SET {assignments} WHERE slug = ?", (*fields.values(), slug))
    finally:
        conn.close()
    events.note("projects", None, db_path(hermes_home), True)


def _delete(hermes_home: Path, slug: str) -> bool:
    conn = connect(db_path(hermes_home))
    try:
        gone = conn.execute("DELETE FROM project_clones WHERE slug = ?", (slug,)).rowcount > 0
    finally:
        conn.close()
    if gone:
        events.note("projects", None, db_path(hermes_home), True)
    return gone


def view(hermes_home: Path, clone: Dict[str, Any]) -> Dict[str, Any]:
    """A pending project as the ``projects`` route lists it."""
    folder = _folder(hermes_home, clone["slug"])
    return {
        "id": ID_PREFIX + clone["slug"],
        "slug": clone["slug"],
        "name": clone["name"],
        "description": clone["description"],
        "created_at": clone["created_at"],
        "last_active": None,
        "status": clone["status"],
        "error": clone["error"],
        "folders": [
            {
                "path": str(folder / entry["dir"]),
                "label": entry["dir"],
                "is_primary": False,
                "git": False,
                "repo": entry["repo"],
                "status": entry["status"],
            }
            for entry in clone["repos"]
        ],
    }


def pending(hermes_home: Path) -> List[Dict[str, Any]]:
    return [view(hermes_home, clone) for clone in _all(hermes_home)]


def start(hermes_home: Path, name: Any, description: Any, repos: Any) -> Dict[str, Any]:
    """Records a new project and makes its folder. Clones nothing: ``spawn`` does."""
    repos = projects.validate(name, description, repos)
    projects_db = hermes_home / "projects.db"
    root = hermes_home / "projects"
    reserved = [clone["slug"] for clone in _all(hermes_home)]
    slug = projects._folder_slug(projects_db, root, name.strip(), reserved)
    (root / slug).mkdir(parents=True)
    now = int(time.time())
    entries = [
        {"repo": repo, "dir": dirname, "status": "queued"}
        for repo, dirname in zip(repos, projects._clone_dirs(repos))
    ]
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            "INSERT INTO project_clones (slug, name, description, repos, status, error, created_at,"
            " updated_at) VALUES (?, ?, ?, ?, 'cloning', NULL, ?, ?)",
            (
                slug,
                name.strip(),
                (description or "").strip() or None,
                json.dumps(entries),
                now,
                now,
            ),
        )
    except BaseException:
        shutil.rmtree(root / slug, ignore_errors=True)
        raise
    finally:
        conn.close()
    events.note("projects", None, db_path(hermes_home), True)
    return view(hermes_home, _get(hermes_home, slug))


def spawn(hermes_home: Path, slug: str) -> None:
    # A thread of its own: a clone can take minutes and shouldn't hold one of the loop's workers.
    threading.Thread(target=run, args=(hermes_home, slug), name=f"memento-clone-{slug}", daemon=True).start()


def _finish(hermes_home: Path, clone: Dict[str, Any], cancel: threading.Event) -> None:
    from hermes_cli import projects_db as pdb

    slug = clone["slug"]
    folder = _folder(hermes_home, slug)
    cloned = []
    for entry in clone["repos"]:
        entry["status"] = "cloning"
        _update(hermes_home, slug, repos=clone["repos"])
        cloned.append(github.clone(hermes_home, entry["repo"], str(folder / entry["dir"]), cancel))
        entry["status"] = "done"
        _update(hermes_home, slug, repos=clone["repos"])
    if cancel.is_set():
        raise github.Cancelled()
    with pdb.connect_closing(db_path=hermes_home / "projects.db") as conn:
        pdb.create_project(
            conn,
            name=clone["name"],
            slug=slug,
            description=clone["description"],
            primary_path=str(folder),
            folders=cloned,
        )
    _delete(hermes_home, slug)


def _fail(hermes_home: Path, slug: str, message: str) -> None:
    shutil.rmtree(_folder(hermes_home, slug), ignore_errors=True)
    clone = _get(hermes_home, slug)
    if clone is None:
        return
    # The failing repo is the one that was cloning; the folder's gone, so the rest start over.
    for entry in clone["repos"]:
        entry["status"] = "failed" if entry["status"] == "cloning" else "queued"
    _update(hermes_home, slug, status="failed", error=message, repos=clone["repos"])
    push.notify("clone_failed", slug, db_path(hermes_home), title=clone["name"])


def run(hermes_home: Path, slug: str) -> None:
    key = (str(hermes_home), slug)
    with _lock:
        if key in _running:
            return
        cancel = _running[key] = threading.Event()
    try:
        clone = _get(hermes_home, slug)
        if clone is not None and clone["status"] == "cloning":
            _finish(hermes_home, clone, cancel)
    except github.Cancelled:
        shutil.rmtree(_folder(hermes_home, slug), ignore_errors=True)
    except github.GitHubError as error:
        _fail(hermes_home, slug, str(error))
    except ImportError:
        _fail(hermes_home, slug, "This Hermes version has no Projects.")
    except Exception:
        logger.exception("memento: creating project %s failed", slug)
        _fail(hermes_home, slug, "Couldn't create the project.")
    finally:
        with _lock:
            _running.pop(key, None)


def _restart(hermes_home: Path, clone: Dict[str, Any]) -> None:
    folder = _folder(hermes_home, clone["slug"])
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    for entry in clone["repos"]:
        entry["status"] = "queued"
    _update(hermes_home, clone["slug"], status="cloning", error=None, repos=clone["repos"])


def retry(hermes_home: Path, slug: str) -> Optional[Dict[str, Any]]:
    """Starts a failed project over. None when there's no failed project of that slug."""
    clone = _get(hermes_home, slug)
    if clone is None or clone["status"] != "failed":
        return None
    _restart(hermes_home, clone)
    spawn(hermes_home, slug)
    return view(hermes_home, _get(hermes_home, slug))


def dismiss(hermes_home: Path, slug: str) -> bool:
    """Drops a pending or failed project, stopping its clone. False when there's none."""
    with _lock:
        cancel = _running.get((str(hermes_home), slug))
    if cancel is not None:
        cancel.set()
    found = _delete(hermes_home, slug)
    shutil.rmtree(_folder(hermes_home, slug), ignore_errors=True)
    return found


def resume(hermes_home: Path) -> None:
    """Clones again every project a restart left mid-clone. Once per home."""
    with _lock:
        if str(hermes_home) in _resumed:
            return
        _resumed.add(str(hermes_home))
    for clone in _all(hermes_home):
        if clone["status"] == "cloning":
            _restart(hermes_home, clone)
            spawn(hermes_home, clone["slug"])
