"""Adding a GitHub repo to a project, or removing one, in the background.

Both answer at once and finish on a thread of their own, so they carry on with the app closed. An
added repo is cloned into ``$HERMES_HOME/projects/<slug>/`` and joins the project in ``projects.db``
only once the clone is in, so a session never gets a worktree in a half-made clone; until then it's
a row in ``memento.db``'s ``project_repos``. A removed repo leaves ``projects.db`` at once, so no new
worktree is made in it, and its clone (only one the plugin made) is deleted after. Sessions that
worked in it are left read-only (``sessions.blocked``). A restart picks both up again (``resume``).
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import events, github, push
from .store import connect, db_path

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_running: Dict[tuple, threading.Event] = {}
_resumed: set = set()

_COLUMNS = "project_id, repo, path, action, status, error"


class RepoError(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def _rows(hermes_home: Path, project_id: Optional[str] = None) -> List[Dict[str, Any]]:
    conn = connect(db_path(hermes_home))
    try:
        query = f"SELECT {_COLUMNS} FROM project_repos"
        found = (
            conn.execute(query + " WHERE project_id = ? ORDER BY created_at", (project_id,))
            if project_id is not None
            else conn.execute(query + " ORDER BY created_at")
        )
        return [dict(zip(("project_id", "repo", "path", "action", "status", "error"), row)) for row in found]
    finally:
        conn.close()


def _put(hermes_home: Path, project_id: str, repo: str, path: str, action: str, status: str) -> None:
    now = int(time.time())
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            """INSERT INTO project_repos (project_id, repo, path, action, status, error, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
               ON CONFLICT(project_id, repo) DO UPDATE SET path = excluded.path,
                   action = excluded.action, status = excluded.status, error = NULL,
                   updated_at = excluded.updated_at""",
            (project_id, repo, path, action, status, now, now),
        )
    finally:
        conn.close()
    events.note("projects", None, db_path(hermes_home), True)


def _set(hermes_home: Path, project_id: str, repo: str, status: str, error: Optional[str]) -> None:
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            "UPDATE project_repos SET status = ?, error = ?, updated_at = ? WHERE project_id = ? AND repo = ?",
            (status, error, int(time.time()), project_id, repo),
        )
    finally:
        conn.close()
    events.note("projects", None, db_path(hermes_home), True)
    if status == "failed":
        try:
            name = getattr(_project(hermes_home, project_id), "name", None)
        except Exception:
            name = None
        push.notify("clone_failed", project_id, db_path(hermes_home), title=name)


def _drop(hermes_home: Path, project_id: str, repo: Optional[str] = None) -> None:
    conn = connect(db_path(hermes_home))
    try:
        if repo is None:
            conn.execute("DELETE FROM project_repos WHERE project_id = ?", (project_id,))
        else:
            conn.execute("DELETE FROM project_repos WHERE project_id = ? AND repo = ?", (project_id, repo))
    finally:
        conn.close()
    events.note("projects", None, db_path(hermes_home), True)


def pending(hermes_home: Path) -> Dict[str, List[Dict[str, Any]]]:
    """Every project's repos being added (``cloning``, ``failed``) or removed (``removing``), as the
    ``projects`` route lists folders."""
    by_project: Dict[str, List[Dict[str, Any]]] = {}
    for row in _rows(hermes_home):
        by_project.setdefault(row["project_id"], []).append(
            {
                "path": row["path"],
                "label": os.path.basename(row["path"]),
                "is_primary": False,
                "git": False,
                "repo": row["repo"],
                "status": row["status"],
                "error": row["error"],
            }
        )
    return by_project


def cloning(hermes_home: Path, project_id: str) -> bool:
    return any(
        row["action"] == "add" and row["status"] == "cloning" for row in _rows(hermes_home, project_id)
    )


def _project(hermes_home: Path, project_id: str) -> Any:
    from hermes_cli import projects_db as pdb

    projects_db = hermes_home / "projects.db"
    if not projects_db.exists():
        return None
    with pdb.connect_closing(db_path=projects_db) as conn:
        return pdb.get_project(conn, project_id)


def _repo_of(folder_path: str) -> Optional[str]:
    if not os.path.exists(os.path.join(folder_path, ".git")):
        return None
    return github.origin_repo(folder_path)


def _managed(hermes_home: Path, path: str) -> bool:
    """A clone the plugin made: a folder inside a project folder under ``$HERMES_HOME/projects``."""
    root = os.path.realpath(hermes_home / "projects")
    real = os.path.realpath(path)
    parent = os.path.dirname(real)
    return os.path.dirname(parent) == root and real != root


def _still_used(hermes_home: Path, path: str) -> bool:
    """Whether any project, archived ones too, still has ``path`` as a folder."""
    from hermes_cli import projects_db as pdb

    with pdb.connect_closing(db_path=hermes_home / "projects.db") as conn:
        projects = pdb.list_projects(conn, include_archived=True)
    real = os.path.realpath(path)
    return any(os.path.realpath(folder.path) == real for p in projects for folder in p.folders)


def _destination(hermes_home: Path, project: Any, repo: str, taken: List[str]) -> str:
    folder = hermes_home / "projects" / project.slug
    owner, name = repo.split("/", 1)
    for candidate in [name, f"{owner}-{name}"] + [f"{owner}-{name}-{n}" for n in range(2, 100)]:
        path = str(folder / candidate)
        if path not in taken and not os.path.exists(path):
            return path
    raise RepoError("There's no free folder name for that repo.")


def add(hermes_home: Path, project_id: str, repo: Any) -> Optional[Dict[str, Any]]:
    """Starts cloning ``owner/name`` into the project. None when there's no such project."""
    if not isinstance(repo, str) or not github.REPO_RE.match(repo.strip()):
        raise ValueError("repo must be owner/name.")
    repo = repo.strip()
    project = _project(hermes_home, project_id)
    if project is None:
        return None
    if any(_repo_of(folder.path) == repo for folder in project.folders):
        raise RepoError(f"{repo} is already in this project.")
    rows = _rows(hermes_home, project_id)
    row = next((r for r in rows if r["repo"] == repo), None)
    if row and row["action"] == "remove":
        raise RepoError(f"{repo} is still being removed.")
    if row and row["status"] == "cloning":
        return row
    taken = [folder.path for folder in project.folders] + [r["path"] for r in rows if r["repo"] != repo]
    path = row["path"] if row else _destination(hermes_home, project, repo, taken)
    _put(hermes_home, project_id, repo, path, "add", "cloning")
    _spawn(hermes_home, project_id, repo)
    return {"project_id": project_id, "repo": repo, "path": path, "status": "cloning"}


def remove(hermes_home: Path, project_id: str, repo: Any) -> bool:
    """Takes ``owner/name`` out of the project, or stops adding it. False when it isn't there."""
    from hermes_cli import projects_db as pdb

    if not isinstance(repo, str) or not repo.strip():
        raise ValueError("repo must be owner/name.")
    repo = repo.strip()
    row = next((r for r in _rows(hermes_home, project_id) if r["repo"] == repo), None)
    if row and row["action"] == "remove":
        return True
    if row:
        # Not in projects.db yet: stop the clone and forget it.
        _cancel(hermes_home, project_id, repo)
        _drop(hermes_home, project_id, repo)
        shutil.rmtree(row["path"], ignore_errors=True)
        return True
    project = _project(hermes_home, project_id)
    if project is None:
        return False
    folder = next((f for f in project.folders if _repo_of(f.path) == repo), None)
    if folder is None:
        return False
    with pdb.connect_closing(db_path=hermes_home / "projects.db") as conn:
        pdb.remove_folder(conn, project_id, folder.path)
    if _managed(hermes_home, folder.path) and not _still_used(hermes_home, folder.path):
        _put(hermes_home, project_id, repo, folder.path, "remove", "removing")
        _spawn(hermes_home, project_id, repo)
    return True


def forget(hermes_home: Path, project_id: str) -> None:
    """A deleted project: stop its clones. Its folders stay, like the project's own."""
    for row in _rows(hermes_home, project_id):
        if row["action"] == "add":
            _cancel(hermes_home, project_id, row["repo"])
            shutil.rmtree(row["path"], ignore_errors=True)
    _drop(hermes_home, project_id)


def _cancel(hermes_home: Path, project_id: str, repo: str) -> None:
    with _lock:
        cancel = _running.get((str(hermes_home), project_id, repo))
    if cancel is not None:
        cancel.set()


def _spawn(hermes_home: Path, project_id: str, repo: str) -> None:
    # A clone can take minutes and shouldn't hold one of the loop's workers.
    threading.Thread(
        target=run, args=(hermes_home, project_id, repo), name=f"memento-repo-{repo}", daemon=True
    ).start()


def run(hermes_home: Path, project_id: str, repo: str) -> None:
    key = (str(hermes_home), project_id, repo)
    with _lock:
        if key in _running:
            return
        cancel = _running[key] = threading.Event()
    try:
        row = next((r for r in _rows(hermes_home, project_id) if r["repo"] == repo), None)
        if row is None:
            return
        if row["action"] == "remove":
            shutil.rmtree(row["path"], ignore_errors=True)
            _drop(hermes_home, project_id, repo)
        elif row["status"] == "cloning":
            _clone(hermes_home, row, cancel)
    except github.Cancelled:
        pass
    except github.GitHubError as error:
        _set(hermes_home, project_id, repo, "failed", str(error))
    except Exception:
        logger.exception("memento: changing %s in project %s failed", repo, project_id)
        _set(hermes_home, project_id, repo, "failed", f"Couldn't add {repo}.")
    finally:
        with _lock:
            _running.pop(key, None)


def _clone(hermes_home: Path, row: Dict[str, Any], cancel: threading.Event) -> None:
    from hermes_cli import projects_db as pdb

    shutil.rmtree(row["path"], ignore_errors=True)
    path = github.clone(hermes_home, row["repo"], row["path"], cancel)
    if cancel.is_set():
        shutil.rmtree(path, ignore_errors=True)
        raise github.Cancelled()
    try:
        with pdb.connect_closing(db_path=hermes_home / "projects.db") as conn:
            pdb.add_folder(conn, row["project_id"], path)
    except ValueError:
        # The project went while the clone ran.
        shutil.rmtree(path, ignore_errors=True)
    _drop(hermes_home, row["project_id"], row["repo"])


def resume(hermes_home: Path) -> None:
    """Picks up every add and remove a restart cut short. Once per home."""
    with _lock:
        if str(hermes_home) in _resumed:
            return
        _resumed.add(str(hermes_home))
    for row in _rows(hermes_home):
        if row["action"] == "remove" or row["status"] == "cloning":
            _spawn(hermes_home, row["project_id"], row["repo"])
