"""Memento's project sessions: chats that work in their own git worktrees of a Hermes Project.

A session spans the project: every git folder of it gets a worktree on the session's branch. The
primary repo's worktree is the session's cwd, and the run's instructions tell the agent where the
others are.

The API server can't put a run in a directory (``POST /v1/runs`` has no cwd), but Hermes's terminal
and file tools take a per-session cwd override (``register_task_env_overrides``), keyed by the run's
task id, which is the session id Memento sends. The plugin makes the worktree with Hermes's own
``worktree_ops`` and registers that override. The override only lives in memory, so the app re-posts
the workspace before every run and the ``pre_tool_call`` hook puts it back after a gateway restart.

The session's permission mode is kept here too, so the hook can enforce plan mode (no tool may
change anything) and every device sees the same mode.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .store import connect

logger = logging.getLogger(__name__)

MODES = ("accept_edits", "auto", "plan")
FIELDS = (
    "session_id",
    "project_id",
    "repo_root",
    "path",
    "branch",
    "mode",
    "plan_pending",
    "created_at",
    "repos",
)
REPO_FIELDS = ("name", "repo_root", "path", "branch")
MAX_PARENT_HOPS = 5
ADJECTIVES = (
    "breezy", "cosmic", "dapper", "fuzzy", "gleaming", "jazzy", "lucky", "mellow", "nimble",
    "peppy", "quirky", "snazzy", "spry", "sunny", "swift", "wobbly", "zesty", "plucky",
)
NOUNS = (
    "badger", "biscuit", "comet", "dumpling", "falcon", "hopper", "lantern", "marmot", "noodle",
    "otter", "pickle", "puffin", "quokka", "sprocket", "thimble", "walrus", "waffle", "yeti",
)
GIT_TIMEOUT_S = 60
MUTATING_TOOLS = frozenset({"write_file", "patch", "execute_code", "delegate_task"})
READ_ONLY_COMMANDS = frozenset(
    "ls cat head tail grep rg find fd pwd wc tree stat file which echo printf env du df diff sort "
    "uniq cut jq basename dirname realpath readlink true".split()
)
READ_ONLY_GIT = frozenset(
    "status log diff show branch ls-files blame rev-parse remote describe grep".split()
)
PLAN_BLOCK = (
    "Plan mode: only read for now. Describe the change you would make in your reply; the user "
    "approves the plan before you act."
)
LIVE_STATUSES = {
    "queued": "running",
    "running": "running",
    "stopping": "running",
    "waiting_for_approval": "waiting_for_approval",
}

# The dashboard shows a session's source as its label. /api/sessions only accepts a fixed set of
# sources, so Memento's sessions start as the API server's and the plugin relabels them.
SESSION_SOURCE = "memento"
RELABELLED_SOURCES = ("api_server", "unknown")

# The API server adapter, kept by _wire_api_server so the hooks can reach its session store.
adapter: Any = None


class WorkspaceError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _record(row: Any) -> Dict[str, Any]:
    record = dict(zip(FIELDS, row))
    record["plan_pending"] = bool(record["plan_pending"])
    try:
        repos = json.loads(record["repos"]) if record["repos"] else []
    except ValueError:
        repos = []
    record["repos"] = [
        {field: repo.get(field) for field in REPO_FIELDS} for repo in repos if isinstance(repo, dict)
    ]
    # A row from before repos were kept: the one tree it has.
    if not record["repos"] and record["path"]:
        record["repos"] = [
            {
                "name": _repo_name(record["repo_root"]),
                "repo_root": record["repo_root"],
                "path": record["path"],
                "branch": record["branch"],
            }
        ]
    return record


def _repo_name(repo_root: str) -> str:
    """``user/repo`` from the checkout's GitHub origin, else the folder's name; never a path."""
    from . import github

    return github.origin_repo(repo_root) or os.path.basename(repo_root.rstrip("/\\")) or repo_root


def read(path: Path, session_id: str) -> Optional[Dict[str, Any]]:
    if not session_id or not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute(
            f"SELECT {', '.join(FIELDS)} FROM project_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
    finally:
        conn.close()
    return _record(row) if row else None


def _parent_of(hermes_home: Path, session_id: str) -> Optional[str]:
    state = hermes_home / "state.db"
    if not state.exists():
        return None
    try:
        # Read-only, so a lookup can never lock the gateway out of its own store.
        with sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
            row = conn.execute(
                "SELECT parent_session_id FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row and isinstance(row[0], str) and row[0] else None


def record_for(path: Path, hermes_home: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """The session's record, or its nearest ancestor's: compression moves a chat to a child session."""
    seen = set()
    current: Optional[str] = session_id
    for _ in range(MAX_PARENT_HOPS + 1):
        if not current or current in seen:
            return None
        seen.add(current)
        found = read(path, current)
        if found:
            return found
        current = _parent_of(hermes_home, current)
    return None


def slug(task: Any = None) -> str:
    """A worktree name of two random words and a few hex digits, so two never clash."""
    return f"{secrets.choice(ADJECTIVES)}-{secrets.choice(NOUNS)}-{secrets.token_hex(2)}"


def _project_repos(projects_db: Path, project_id: str) -> list[str]:
    """The project's git folders, primary first."""
    from hermes_cli import projects_db as pdb

    if not projects_db.exists():
        raise ValueError("No such project.")
    with pdb.connect_closing(db_path=projects_db) as conn:
        projects = pdb.list_projects(conn)
    project = next((p for p in projects if str(p.id) == project_id), None)
    if project is None:
        raise ValueError("No such project.")
    folders = sorted(project.folders, key=lambda folder: not folder.is_primary)
    repos = []
    for folder in folders:
        root = os.path.abspath(os.path.expanduser(folder.path))
        if os.path.exists(os.path.join(root, ".git")) and root not in repos:
            repos.append(root)
    if not repos:
        raise ValueError("This project has no git repository.")
    return repos


def _create_worktree(repo_root: str, name: str) -> Dict[str, str]:
    from hermes_cli.worktree_ops import _setup_worktree

    info = None
    try:
        info = _setup_worktree(repo_root=repo_root, sync_base=True, name=name)
    except Exception:
        logger.debug("memento: worktree setup with a fetch failed in %s", repo_root, exc_info=True)
    if not info:
        # Offline, or no remote: branch from what's checked out.
        try:
            info = _setup_worktree(repo_root=repo_root, sync_base=False, name=name)
        except Exception as error:
            raise WorkspaceError(f"Couldn't create a worktree in {repo_root}: {error}") from None
    if not isinstance(info, dict) or not info.get("path") or not info.get("branch"):
        raise WorkspaceError(f"Couldn't create a worktree in {repo_root}.")
    return {"path": str(info["path"]), "branch": str(info["branch"])}


def _upsert(path: Path, session_id: str, project_id: str, repos: list[Dict[str, str]], mode: str):
    first = repos[0]
    conn = connect(path)
    try:
        conn.execute(
            """INSERT INTO project_sessions
                   (session_id, project_id, repo_root, path, branch, mode, plan_pending, created_at, repos)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
               ON CONFLICT(session_id) DO UPDATE SET
                   project_id = excluded.project_id, repo_root = excluded.repo_root,
                   path = excluded.path, branch = excluded.branch, mode = excluded.mode,
                   plan_pending = 0, repos = excluded.repos""",
            (
                session_id,
                project_id,
                first["repo_root"],
                first["path"],
                first["branch"],
                mode,
                int(time.time() * 1000),
                json.dumps(repos, separators=(",", ":")),
            ),
        )
    finally:
        conn.close()
    return read(path, session_id)


def ensure(
    path: Path,
    hermes_home: Path,
    session_id: str,
    project_id: Any,
    task: Any,
    mode: Any,
) -> Dict[str, Any]:
    """The session's workspace: a worktree in each of the project's repos, made the first time (a
    missing one is made on a later call, so a half-made workspace heals on retry). Doesn't register
    the cwd."""
    if not isinstance(project_id, (str, int)) or isinstance(project_id, bool) or not str(project_id).strip():
        raise ValueError("project_id is required.")
    if mode is not None and mode not in MODES:
        raise ValueError("mode must be accept_edits, auto or plan.")
    if task is not None and not isinstance(task, str):
        raise ValueError("task must be a string.")
    project_id = str(project_id).strip()
    roots = _project_repos(hermes_home / "projects.db", project_id)
    record = read(path, session_id)
    existing = {repo["repo_root"]: repo for repo in (record or {}).get("repos", [])}
    if record and all(root in existing and os.path.isdir(existing[root]["path"] or "") for root in roots):
        if mode and mode != record["mode"]:
            record = set_mode(path, session_id, mode)
        return record
    # One branch name across the repos; a later repo joins the name the first one got.
    name = next((repo["branch"].split("/", 1)[1] for repo in existing.values() if repo.get("branch")), None)
    name = name or slug(task)
    repos = []
    for root in roots:
        kept = existing.get(root)
        if kept and os.path.isdir(kept["path"] or ""):
            repos.append(kept)
            continue
        tree = _create_worktree(root, name)
        repos.append({"name": _repo_name(root), "repo_root": root, **tree})
    return _upsert(path, session_id, project_id, repos, mode or (record or {}).get("mode") or MODES[0])


def instructions(record: Dict[str, Any]) -> str:
    """What the run's system prompt tells the agent about its worktrees. Fixed per session."""
    repos = record.get("repos") or []
    if not repos:
        return ""
    if len(repos) == 1:
        return (
            f"You are working in a git worktree of {repos[0]['name']} at {repos[0]['path']} "
            f"(branch {repos[0]['branch']}). Keep all work inside it."
        )
    lines = [
        f"- {repo['name']} at {repo['path']}" + (" (your current directory)" if i == 0 else "")
        for i, repo in enumerate(repos)
    ]
    return (
        f"You are working in git worktrees of this project's repos, all on branch {repos[0]['branch']}:\n"
        + "\n".join(lines)
        + "\nKeep all work inside them."
    )


def apply_cwd(session_id: str, cwd: str) -> None:
    """Points the session's terminal and file tools into its worktree. In memory only."""
    try:
        from tools.terminal_tool import register_task_env_overrides
    except ImportError:
        logger.debug("memento: this Hermes has no per-task cwd override")
        return
    register_task_env_overrides(session_id, {"cwd": cwd})


def _has_cwd(session_id: str) -> bool:
    try:
        from tools.terminal_tool import get_session_cwd
    except ImportError:
        return True
    return bool(get_session_cwd(session_id))


def _clear_cwd(session_id: str) -> None:
    try:
        from tools.terminal_tool import clear_task_env_overrides
    except ImportError:
        return
    clear_task_env_overrides(session_id)


def stamp(db: Any, record: Dict[str, Any]) -> bool:
    """Writes the worktree onto the Hermes session row, so Hermes groups it under the project too."""
    write = getattr(db, "_execute_write", None)
    if not callable(write) or not record.get("path"):
        return False

    def run(conn):
        try:
            cursor = conn.execute(
                "UPDATE sessions SET cwd = ?, git_branch = ?, git_repo_root = ? WHERE id = ?",
                (record["path"], record["branch"], record["repo_root"], record["session_id"]),
            )
        except sqlite3.OperationalError:
            # An older session schema without these columns.
            return False
        return bool(cursor.rowcount)

    return bool(write(run))


def set_mode(path: Path, session_id: str, mode: Any) -> Optional[Dict[str, Any]]:
    """Sets the mode and clears a pending plan, which the app does to dismiss it everywhere."""
    if mode not in MODES:
        raise ValueError("mode must be accept_edits, auto or plan.")
    if not read(path, session_id):
        return None
    conn = connect(path)
    try:
        conn.execute(
            "UPDATE project_sessions SET mode = ?, plan_pending = 0 WHERE session_id = ?",
            (mode, session_id),
        )
    finally:
        conn.close()
    return read(path, session_id)


def set_plan_pending(path: Path, session_id: str, pending: bool) -> None:
    conn = connect(path)
    try:
        conn.execute(
            "UPDATE project_sessions SET plan_pending = ? WHERE session_id = ?",
            (1 if pending else 0, session_id),
        )
    finally:
        conn.close()


def _delete(path: Path, session_id: str) -> None:
    conn = connect(path)
    try:
        conn.execute("DELETE FROM project_sessions WHERE session_id = ?", (session_id,))
    finally:
        conn.close()


def _git(cwd: str, *args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["git", "-C", cwd, *args],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except FileNotFoundError:
        raise WorkspaceError("git isn't installed on the server.", 501) from None
    except subprocess.TimeoutExpired:
        raise WorkspaceError("git took too long.", 504) from None


def _keep_reason(tree: str) -> Optional[str]:
    """Why a worktree can't go: ``dirty`` or ``unpushed``, else None."""
    status = _git(tree, "status", "--porcelain")
    if status.returncode != 0:
        raise WorkspaceError(status.stderr.strip() or "git status failed.")
    if status.stdout.strip():
        return "dirty"
    # Commits no remote ref holds; with no remote at all everything counts, so the tree stays.
    unpushed = _git(tree, "rev-list", "--count", "HEAD", "--not", "--remotes")
    if unpushed.returncode != 0 or (unpushed.stdout.strip() or "1") != "0":
        return "unpushed"
    return None


def remove(path: Path, session_id: str) -> Dict[str, Any]:
    """Removes the session's worktrees where nothing would be lost, and forgets the session once
    none is left.

    A tree with uncommitted changes or with commits no remote has is kept, and so is the record, so
    a later delete can try again once the work is pushed. Doesn't clear the cwd override.
    """
    record = read(path, session_id)
    if not record:
        return {"removed": False, "kept": []}
    kept = []
    for repo in record["repos"]:
        tree = repo["path"]
        if not tree or not os.path.isdir(tree):
            continue
        reason = _keep_reason(tree)
        if reason:
            kept.append({"name": repo["name"], "reason": reason})
            continue
        _git(repo["repo_root"], "worktree", "unlock", tree)
        removed = _git(repo["repo_root"], "worktree", "remove", tree)
        if removed.returncode != 0:
            raise WorkspaceError(removed.stderr.strip() or "git worktree remove failed.")
        if repo["branch"]:
            _git(repo["repo_root"], "branch", "-d", repo["branch"])
    if kept:
        return {"removed": False, "kept": kept}
    _delete(path, session_id)
    return {"removed": True, "kept": []}


def label(db: Any, session_id: str) -> bool:
    """Marks a session as Memento's, so the Hermes dashboard labels it."""

    def write(conn):
        placeholders = ", ".join("?" for _ in RELABELLED_SOURCES)
        # Never takes a session from another surface (Telegram, the CLI, ...).
        cursor = conn.execute(
            f"UPDATE sessions SET source = ? WHERE id = ? AND source IN ({placeholders})",
            (SESSION_SOURCE, session_id, *RELABELLED_SOURCES),
        )
        if cursor.rowcount:
            return True
        row = conn.execute("SELECT source FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return bool(row) and row[0] == SESSION_SOURCE

    return db._execute_write(write)


def live_runs(adapter: Any) -> Dict[str, str]:
    """Each session with a run in flight: ``running`` or ``waiting_for_approval``."""
    statuses = getattr(adapter, "_run_statuses", None)
    if not isinstance(statuses, dict):
        return {}
    live: Dict[str, str] = {}
    for status in list(statuses.values()):
        if not isinstance(status, dict):
            continue
        state = LIVE_STATUSES.get(status.get("status"))
        session_id = status.get("session_id")
        if not state or not isinstance(session_id, str) or not session_id:
            continue
        if live.get(session_id) != "waiting_for_approval":
            live[session_id] = state
    return live


def read_only(command: Any) -> bool:
    """Whether a shell command only looks: a plain pipeline of listing commands and read-only git."""
    if not isinstance(command, str) or not command.strip():
        return False
    # Redirections and substitutions can write or run anything.
    if re.search(r">|<\(|\$\(|`", command):
        return False
    for segment in re.split(r"\|\|?|&&|;|\n", command):
        words = segment.strip().split()
        if not words:
            continue
        head = os.path.basename(words[0])
        if head == "git":
            rest = words[1:]
            while rest and rest[0].startswith("-"):
                rest = rest[2:] if rest[0] in ("-C", "-c") else rest[1:]
            if not rest or rest[0] not in READ_ONLY_GIT:
                return False
        elif head not in READ_ONLY_COMMANDS:
            return False
    return True


def _paths():
    # Hermes runs hooks inside the session's profile scope, so this is that profile's home.
    from hermes_constants import get_hermes_home

    from .store import db_path

    home = Path(get_hermes_home())
    return db_path(home), home


def before_tool(**kwargs: Any) -> Optional[Dict[str, str]]:
    """The ``pre_tool_call`` hook: keeps the session in its worktree and enforces plan mode."""
    try:
        return _before_tool(kwargs)
    except Exception:
        logger.debug("memento: pre_tool_call failed", exc_info=True)
        return None


def _before_tool(kwargs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    task_id = kwargs.get("task_id") or ""
    session_id = kwargs.get("session_id") or ""
    path, home = _paths()
    if not path.exists():
        return None
    record = record_for(path, home, task_id)
    if not record and session_id and session_id != task_id:
        record = record_for(path, home, session_id)
    if not record:
        return None
    if record["path"] and task_id and not _has_cwd(task_id):
        # The gateway restarted since the app last posted the workspace.
        apply_cwd(task_id, record["path"])
    if record["mode"] != "plan":
        return None
    tool = kwargs.get("tool_name")
    args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
    if tool in MUTATING_TOOLS or (tool == "terminal" and not read_only(args.get("command"))):
        return {"action": "block", "message": PLAN_BLOCK}
    return None


def before_llm(**kwargs: Any) -> None:
    """The ``pre_llm_call`` hook: a new turn means the user answered the pending plan."""
    try:
        path, home = _paths()
        record = path.exists() and record_for(path, home, kwargs.get("session_id") or "")
        if record and record["plan_pending"]:
            set_plan_pending(path, record["session_id"], False)
    except Exception:
        logger.debug("memento: pre_llm_call failed", exc_info=True)


def after_run(**kwargs: Any) -> None:
    """The ``on_session_end`` hook: a finished plan-mode turn leaves a plan waiting for the user."""
    try:
        path, home = _paths()
        record = path.exists() and record_for(path, home, kwargs.get("session_id") or "")
        if not record:
            return
        if record["mode"] == "plan" and kwargs.get("completed") and not kwargs.get("interrupted"):
            set_plan_pending(path, record["session_id"], True)
        db = getattr(adapter, "_session_db", None)
        if db is not None:
            stamp(db, record)
            # The app labels after a turn too, but a project session is Memento's from its first one.
            for session_id in {record["session_id"], kwargs.get("session_id") or ""} - {""}:
                label(db, session_id)
    except Exception:
        logger.debug("memento: on_session_end failed", exc_info=True)
