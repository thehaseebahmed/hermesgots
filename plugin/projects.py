"""Hermes Projects for Gots's Code screen, read from the profile's ``projects.db``.

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
            # A project put away doesn't keep working: its switch goes off first, so a failure here
            # leaves a project that isn't archived but isn't working either, never the other way.
            if archived:
                from .afk import turn_off

                turn_off(hermes_home, project_id)
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


def _columns(conn: sqlite3.Connection) -> set:
    return {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}


def _model_usage(conn: sqlite3.Connection) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """Each session's tokens and cost per model, from Hermes's per-call rows.

    A session's ``model`` column is overwritten on a mid-session switch while its counters keep
    accumulating, so it can't say which model used what. ``session_model_usage`` records every call
    under the model that ran it (auxiliary calls included, since they're real spend). Empty when the
    table isn't there, which is an older Hermes."""
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "session_model_usage" not in tables:
        return {}
    found: Dict[str, Dict[str, Dict[str, Any]]] = {}
    query = (
        "SELECT session_id, model, "
        + ", ".join(f"SUM(COALESCE({c}, 0))" for c in USAGE_COLUMNS)
        + ", SUM(COALESCE(estimated_cost_usd, 0)) FROM session_model_usage GROUP BY session_id, model"
    )
    for session_id, model, *rest in conn.execute(query):
        found.setdefault(session_id, {})[str(model or "")] = {
            "counts": [int(c or 0) for c in rest[:4]],
            "cost": float(rest[4] or 0.0),
        }
    return found


def _scale(shares: Dict[str, Dict[str, Any]], index: int, covered: int, target: int) -> None:
    """Shrink one token column so the models' shares add up to the session row exactly."""
    raw = {name: share["counts"][index] * target / covered for name, share in shares.items()}
    floors = {name: int(value) for name, value in raw.items()}
    left = target - sum(floors.values())
    by_fraction = sorted(raw, key=lambda name: raw[name] - floors[name], reverse=True)
    for name in by_fraction[:left]:
        floors[name] += 1
    for name, share in shares.items():
        share["counts"][index] = floors[name]


def _fit(
    shares: Dict[str, Dict[str, Any]], counts: List[int], cost: Optional[float], model: str
) -> None:
    """Make the per-model split add up to the session row, the source of truth.

    A shortfall (a session from before the per-call table, an absolute overwrite, a delta still
    queued) goes to the session's own model, the only one it names. An excess is scaled back across
    the models the per-call rows name. A session row with no cost figure gets none: the split must
    never name a cost the total doesn't."""
    for index, count in enumerate(counts):
        target = int(count or 0)
        covered = sum(share["counts"][index] for share in shares.values())
        if covered > target:
            _scale(shares, index, covered, target)
    for index, count in enumerate(counts):
        short = int(count or 0) - sum(share["counts"][index] for share in shares.values())
        if short > 0:
            own = shares.setdefault(model, {"counts": [0, 0, 0, 0], "cost": 0.0})
            own["counts"][index] += short
    if cost is None:
        for share in shares.values():
            share["cost"] = 0.0
        return
    target_cost = float(cost)
    covered_cost = sum(share["cost"] for share in shares.values())
    if covered_cost > target_cost and covered_cost:
        factor = target_cost / covered_cost
        for share in shares.values():
            share["cost"] *= factor
    elif target_cost > covered_cost:
        own = shares.setdefault(model, {"counts": [0, 0, 0, 0], "cost": 0.0})
        own["cost"] += target_cost - covered_cost


def usage(hermes_home: Path, project_id: str) -> Optional[Dict[str, Any]]:
    """What the sessions in the project's folders used, summed from Hermes's session store, with
    each session's own share split by model so the app can price it. None when there's no such
    project; zeros when the store can't be read."""
    from hermes_cli import projects_db as pdb

    projects_db = hermes_home / "projects.db"
    if not projects_db.exists():
        return None
    with pdb.connect_closing(db_path=projects_db) as conn:
        project = pdb.get_project(conn, project_id)
    if project is None:
        return None
    totals: Dict[str, Any] = {
        "sessions": 0,
        "cost_usd": None,
        **{c: 0 for c in USAGE_COLUMNS},
        "threads": [],
    }
    state = hermes_home / "state.db"
    if not state.exists():
        return totals
    folders = [os.path.abspath(os.path.expanduser(f.path)) for f in project.folders]
    try:
        # Read-only, so it can never lock the gateway out of its own store.
        with sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
            have = _columns(conn)
            optional = [c for c in ("model", "title", "started_at", "last_activity_at") if c in have]
            found = conn.execute(
                "SELECT id, cwd, parent_session_id, "
                + ", ".join(f"COALESCE({c}, 0)" for c in USAGE_COLUMNS)
                + ", COALESCE(actual_cost_usd, estimated_cost_usd)"
                + "".join(f", {c}" for c in optional)
                + " FROM sessions"
            ).fetchall()
            by_model = _model_usage(conn)
    except sqlite3.Error:
        logger.debug("gots: couldn't read usage for project %s", project_id, exc_info=True)
        return totals
    rows = {}
    for session_id, cwd, parent, *rest in found:
        counts, cost, extra = rest[:4], rest[4], dict(zip(optional, rest[5:]))
        rows[session_id] = (cwd, parent, counts, cost, extra)

    def root(session_id: str) -> str:
        # A compressed session goes on in a child row; it's still one session.
        seen = set()
        while session_id not in seen:
            seen.add(session_id)
            parent = rows[session_id][1]
            if not parent or parent not in rows:
                return session_id
            session_id = parent
        return session_id

    def inside(cwd: Any) -> bool:
        if not cwd or not str(cwd).strip():
            return False
        path = os.path.abspath(os.path.expanduser(str(cwd).strip()))
        return any(_owns(folder, path) for folder in folders)

    threads: Dict[str, Dict[str, Any]] = {}
    for session_id, (cwd, _parent, counts, cost, extra) in rows.items():
        top = root(session_id)
        if not (inside(cwd) or inside(rows[top][0])):
            continue
        thread = threads.get(top)
        if thread is None:
            top_extra = rows[top][4]
            thread = threads[top] = {
                "id": top,
                "title": None,
                "started_at": top_extra.get("started_at"),
                "last_active": None,
                "models": {},
            }
        if extra.get("title") and (thread["title"] is None or session_id == top):
            thread["title"] = extra["title"]
        active = extra.get("last_activity_at") or extra.get("started_at")
        if active and (thread["last_active"] is None or active > thread["last_active"]):
            thread["last_active"] = active
        model = str(extra.get("model") or "")
        # The per-call rows split a session that switched models; the session row stays the total.
        shares = {
            name: {"counts": list(share["counts"]), "cost": share["cost"]}
            for name, share in by_model.get(session_id, {}).items()
        }
        _fit(shares, [int(c or 0) for c in counts], None if cost is None else float(cost), model)
        for name, share in shares.items():
            if not any(share["counts"]) and not share["cost"]:
                continue
            bucket = thread["models"].setdefault(
                name, {"model": name or None, "cost_usd": None, **{c: 0 for c in USAGE_COLUMNS}}
            )
            for column, count in zip(USAGE_COLUMNS, share["counts"]):
                bucket[column] += count
            # The session row says whether cost was known at all; a genuine 0.0 (a free model)
            # must not read back as unknown, so the gate is on the session's cost, not the
            # share's truthiness.
            if cost is not None:
                bucket["cost_usd"] = (bucket["cost_usd"] or 0.0) + share["cost"]
        # Totals come from the session rows, so a session with no per-model rows reports the same
        # as before and the split can never disagree with the total.
        for column, count in zip(USAGE_COLUMNS, counts):
            totals[column] += int(count or 0)
        if cost is not None:
            totals["cost_usd"] = (totals["cost_usd"] or 0.0) + float(cost)
    totals["sessions"] = len(threads)
    totals["threads"] = [{**t, "models": list(t["models"].values())} for t in threads.values()]
    return totals


def remove(hermes_home: Path, project_id: str) -> bool:
    """Deletes the project's record. Its folders and clones stay on disk."""
    from hermes_cli import projects_db as pdb

    projects_db = hermes_home / "projects.db"
    if not projects_db.exists():
        return False
    with pdb.connect_closing(db_path=projects_db) as conn:
        removed = bool(pdb.delete_project(conn, project_id))
    if removed:
        from .afk import forget

        try:
            forget(hermes_home, project_id)
        except Exception:
            # The project's record is gone either way: a switch left behind is a row nothing reads,
            # and failing the request here would report a delete that did happen as a failure.
            logger.warning("gots: couldn't forget %s's AFK switch", project_id, exc_info=True)
    return removed
