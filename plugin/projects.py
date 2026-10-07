"""Hermes Projects for Memento's Code screen, read from the profile's ``projects.db``.

Hermes keeps no "last worked on" time for a project. The desktop app groups sessions under the
project whose folder holds their cwd, so this does the same over the session store's cwds.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)


def _owns(folder: str, path: str) -> bool:
    stem = folder.rstrip("/\\")
    return path == stem or path.startswith(stem + os.sep) or path.startswith(stem + "/")


def _is_git_repo(path: str) -> bool:
    # A worktree's .git is a file, so exists() rather than isdir().
    return os.path.exists(os.path.join(path, ".git"))


def _base_branch(path: str) -> Optional[str]:
    """The branch a session's worktree starts from: the remote's default, else what's checked out."""
    for args in (["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], ["branch", "--show-current"]):
        try:
            result = subprocess.run(
                ["git", "-C", path, *args],
                capture_output=True,
                text=True,
                timeout=5,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        name = result.stdout.strip()
        if result.returncode == 0 and name:
            return name.split("/", 1)[1] if name.startswith("origin/") else name
    return None


def _last_active(projects: List[Any], cwds: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    folders = [(folder.path, project.id) for project in projects for folder in project.folders]
    latest: Dict[str, float] = {}
    for row in cwds:
        cwd = os.path.abspath(os.path.expanduser(str(row.get("cwd") or "").strip()))
        owners = [(folder, pid) for folder, pid in folders if _owns(folder, cwd)]
        if not owners:
            continue
        # Nested projects: the innermost folder owns the cwd, as in Hermes's own grouping.
        pid = max(owners, key=lambda owner: len(owner[0]))[1]
        latest[pid] = max(latest.get(pid, 0.0), float(row.get("last_active") or 0))
    return latest


def read(
    projects_db: Path,
    session_db: Optional[Any],
    pending: Iterable[Dict[str, Any]] = (),
    changes: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    pins: Optional[Dict[str, int]] = None,
) -> List[Dict[str, Any]]:
    """Every project, archived ones too, as Hermes lists them, then the ones still cloning
    (``clones.py``). ``changes`` are each project's repos being added or removed (``repos.py``)."""
    from hermes_cli import projects_db as pdb

    from . import github

    changes = changes or {}
    pins = pins or {}
    rows: List[Dict[str, Any]] = []
    if projects_db.exists():
        with pdb.connect_closing(db_path=projects_db) as conn:
            projects = pdb.list_projects(conn, include_archived=True)
        cwds = getattr(session_db, "distinct_session_cwds", None)
        latest = _last_active(projects, cwds() if callable(cwds) else [])
        rows = [
            {
                "id": project.id,
                "slug": project.slug,
                "name": project.name,
                "description": project.description or None,
                "created_at": project.created_at,
                "last_active": latest.get(project.id) or None,
                "status": "ready",
                "archived": bool(getattr(project, "archived", False)),
                "pinned_at": pins.get(project.id),
                "folders": [
                    {
                        "path": folder.path,
                        "label": folder.label,
                        "is_primary": bool(folder.is_primary),
                        "git": _is_git_repo(folder.path),
                        # The app names repos `user/repo`, never by their path.
                        "repo": github.origin_repo(folder.path) if _is_git_repo(folder.path) else None,
                        "branch": _base_branch(folder.path) if _is_git_repo(folder.path) else None,
                    }
                    for folder in project.folders
                ]
                + changes.get(project.id, []),
            }
            for project in projects
        ]
    # The instant between a finished clone's project row and its pending row going away.
    slugs = {row["slug"] for row in rows}
    return rows + [row for row in pending if row["slug"] not in slugs]


def _folder_slug(projects_db: Path, root: Path, name: str, reserved: Iterable[str] = ()) -> str:
    """The project's slug, free in ``projects.db`` and among ``reserved`` and as a folder under ``root``."""
    from hermes_cli import projects_db as pdb

    base = pdb._slugify(name)
    taken = set(reserved)
    if projects_db.exists():
        with pdb.connect_closing(db_path=projects_db) as conn:
            taken = {project.slug for project in pdb.list_projects(conn, include_archived=True)}
    slug, n = base, 1
    while slug in taken or (root / slug).exists():
        n += 1
        slug = base[: 64 - len(f"-{n}")].rstrip("-_") + f"-{n}"
    return slug


def _clone_dirs(repos: List[str]) -> List[str]:
    """Each repo's folder name; owner-name when two repos share a name."""
    names = [repo.split("/")[1] for repo in repos]
    return [
        repo.replace("/", "-") if names.count(name) > 1 else name for repo, name in zip(repos, names)
    ]


def validate(name: Any, description: Any, repos: Any) -> List[str]:
    """Checks a new project's fields and returns its repos, de-duplicated."""
    from . import github

    if not isinstance(name, str) or not name.strip():
        raise ValueError("Name the project.")
    if description is not None and not isinstance(description, str):
        raise ValueError("description must be a string.")
    if not isinstance(repos, list) or not all(isinstance(repo, str) for repo in repos):
        raise ValueError("repos must be a list of owner/name.")
    repos = list(dict.fromkeys(repo.strip() for repo in repos))
    bad = next((repo for repo in repos if not github.REPO_RE.match(repo)), None)
    if bad is not None:
        raise ValueError(f"{bad} isn't owner/name.")
    return repos


def update(
    hermes_home: Path,
    project_id: str,
    name: Any,
    description: Any,
    archived: Any = None,
    pinned: Any = None,
) -> bool:
    """Renames a project, changes its description, archives or restores it, or pins it. False when
    there's no such project."""
    from hermes_cli import projects_db as pdb

    if name is not None and (not isinstance(name, str) or not name.strip()):
        raise ValueError("Name the project.")
    if description is not None and not isinstance(description, str):
        raise ValueError("description must be a string.")
    for flag in (archived, pinned):
        if flag is not None and not isinstance(flag, bool):
            raise ValueError("archived and pinned must be true or false.")
    with pdb.connect_closing(db_path=hermes_home / "projects.db") as conn:
        if pdb.get_project(conn, project_id) is None:
            return False
        if name is not None or description is not None:
            pdb.update_project(
                conn,
                project_id,
                name=name.strip() if name is not None else None,
                description=description.strip() if description is not None else None,
            )
        if archived is not None:
            change = getattr(pdb, "archive_project" if archived else "restore_project", None)
            if change is None:
                raise ImportError("This Hermes version can't archive projects.")
            change(conn, project_id)
    if pinned is not None:
        _pin(hermes_home, project_id, pinned)
    return True


def _pin(hermes_home: Path, project_id: str, pinned: bool) -> None:
    from .store import connect, db_path

    conn = connect(db_path(hermes_home))
    try:
        if pinned:
            conn.execute(
                "INSERT OR IGNORE INTO project_pins (project_id, pinned_at) VALUES (?, ?)",
                (project_id, int(time.time())),
            )
        else:
            conn.execute("DELETE FROM project_pins WHERE project_id = ?", (project_id,))
    finally:
        conn.close()


def pins(hermes_home: Path) -> Dict[str, int]:
    from .store import connect, db_path

    conn = connect(db_path(hermes_home))
    try:
        return dict(conn.execute("SELECT project_id, pinned_at FROM project_pins"))
    finally:
        conn.close()


USAGE_COLUMNS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")


def usage(hermes_home: Path, project_id: str) -> Optional[Dict[str, Any]]:
    """What the sessions in the project's folders used, summed from Hermes's session store. None
    when there's no such project; zeros when the store can't be read."""
    from hermes_cli import projects_db as pdb

    projects_db = hermes_home / "projects.db"
    if not projects_db.exists():
        return None
    with pdb.connect_closing(db_path=projects_db) as conn:
        project = pdb.get_project(conn, project_id)
    if project is None:
        return None
    totals: Dict[str, Any] = {"sessions": 0, "cost_usd": None, **{c: 0 for c in USAGE_COLUMNS}}
    state = hermes_home / "state.db"
    if not state.exists():
        return totals
    folders = [os.path.abspath(os.path.expanduser(f.path)) for f in project.folders]
    try:
        # Read-only, so it can never lock the gateway out of its own store.
        with sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
            found = conn.execute(
                "SELECT cwd, parent_session_id, "
                + ", ".join(f"COALESCE({c}, 0)" for c in USAGE_COLUMNS)
                + ", COALESCE(actual_cost_usd, estimated_cost_usd) FROM sessions"
                " WHERE cwd IS NOT NULL AND TRIM(cwd) != ''"
            ).fetchall()
    except sqlite3.Error:
        logger.debug("memento: couldn't read usage for project %s", project_id, exc_info=True)
        return totals
    for cwd, parent, *counts, cost in found:
        cwd = os.path.abspath(os.path.expanduser(str(cwd).strip()))
        if not any(_owns(folder, cwd) for folder in folders):
            continue
        # A compressed session goes on in a child row; it's still one session.
        if not parent:
            totals["sessions"] += 1
        for column, count in zip(USAGE_COLUMNS, counts):
            totals[column] += int(count or 0)
        if cost is not None:
            totals["cost_usd"] = (totals["cost_usd"] or 0.0) + float(cost)
    return totals


def remove(hermes_home: Path, project_id: str) -> bool:
    """Deletes the project's record. Its folders and clones stay on disk."""
    from hermes_cli import projects_db as pdb

    projects_db = hermes_home / "projects.db"
    if not projects_db.exists():
        return False
    with pdb.connect_closing(db_path=projects_db) as conn:
        return bool(pdb.delete_project(conn, project_id))
