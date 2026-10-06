"""Hermes Projects for Memento's Code screen, read from the profile's ``projects.db``.

Hermes keeps no "last worked on" time for a project. The desktop app groups sessions under the
project whose folder holds their cwd, so this does the same over the session store's cwds.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


def _owns(folder: str, path: str) -> bool:
    stem = folder.rstrip("/\\")
    return path == stem or path.startswith(stem + os.sep) or path.startswith(stem + "/")


def _is_git_repo(path: str) -> bool:
    # A worktree's .git is a file, so exists() rather than isdir().
    return os.path.exists(os.path.join(path, ".git"))


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


def read(projects_db: Path, session_db: Optional[Any]) -> List[Dict[str, Any]]:
    from hermes_cli import projects_db as pdb

    from . import github

    if not projects_db.exists():
        return []
    with pdb.connect_closing(db_path=projects_db) as conn:
        projects = pdb.list_projects(conn)
    cwds = getattr(session_db, "distinct_session_cwds", None)
    latest = _last_active(projects, cwds() if callable(cwds) else [])
    return [
        {
            "id": project.id,
            "slug": project.slug,
            "name": project.name,
            "description": project.description or None,
            "created_at": project.created_at,
            "last_active": latest.get(project.id) or None,
            "folders": [
                {
                    "path": folder.path,
                    "label": folder.label,
                    "is_primary": bool(folder.is_primary),
                    "git": _is_git_repo(folder.path),
                    # The app names repos `user/repo`, never by their path.
                    "repo": github.origin_repo(folder.path) if _is_git_repo(folder.path) else None,
                }
                for folder in project.folders
            ],
        }
        for project in projects
    ]


def _folder_slug(projects_db: Path, root: Path, name: str) -> str:
    """The project's slug, free both in ``projects.db`` and as a folder under ``root``."""
    from hermes_cli import projects_db as pdb

    base = pdb._slugify(name)
    taken = set()
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


def create(hermes_home: Path, name: Any, description: Any, repos: Any) -> Dict[str, Any]:
    """Creates a project in ``$HERMES_HOME/projects/<slug>`` with each repo cloned inside it.

    A repo in two projects gets two clones, so their branches and changes stay apart.
    """
    from hermes_cli import projects_db as pdb

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

    projects_db = hermes_home / "projects.db"
    root = hermes_home / "projects"
    slug = _folder_slug(projects_db, root, name.strip())
    folder = root / slug
    folder.mkdir(parents=True)
    try:
        clones = [
            github.clone(hermes_home, repo, str(folder / dirname))
            for repo, dirname in zip(repos, _clone_dirs(repos))
        ]
        with pdb.connect_closing(db_path=projects_db) as conn:
            pid = pdb.create_project(
                conn,
                name=name.strip(),
                slug=slug,
                description=(description or "").strip() or None,
                primary_path=str(folder),
                folders=clones,
            )
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return {"id": pid, "slug": slug, "path": str(folder), "folders": clones}
