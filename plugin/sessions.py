"""Gots's project sessions: chats that work in their own git worktrees of a Hermes Project.

A session spans the project: every git folder of it gets a worktree on the session's branch. The
primary repo's worktree is the session's cwd, and the run's instructions tell the agent where the
others are.

The API server can't put a run in a directory (``POST /v1/runs`` has no cwd), but Hermes's terminal
and file tools take a per-session cwd override (``register_task_env_overrides``), keyed by the run's
task id, which is the session id Gots sends. The plugin makes the worktree with Hermes's own
``worktree_ops`` and registers that override. The override only lives in memory, so the app re-posts
the workspace before every run and the ``pre_tool_call`` hook puts it back after a gateway restart.

The session's permission mode is kept here too, so the hook can enforce plan mode (no tool may
change anything) and every device sees the same mode. A finished plan-mode reply is saved as a
Markdown file under the project's ``plans/`` folder, named after the session branch and the time.
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
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

from . import approvals, events, push
from .store import connect

logger = logging.getLogger(__name__)

MODES = ("accept_edits", "auto", "plan")
# What earlier versions wrote for a mode of their own; a session left in one reads as Auto.
LEGACY_MODES = {"theseus": "auto"}
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
    "plan_file",
    "files_dir",
)
REPO_FIELDS = ("name", "repo_root", "path", "branch")
MAX_PARENT_HOPS = 5
# How far a chat's session id may have been moved on by compression. Hermes walks a thousand and
# has met real lineages of 180 (#125041): a shorter bound silently keys the run on a mid-chain id,
# which is the wedge the walk exists to avoid. The loop also stops on a repeat, so a corrupt store
# can't walk forever.
COMPRESSION_DEPTH = 1000
# Hermes marks children that fork off their parent instead of continuing it: a branch, a delegation,
# a reset, or a session a tool made. Those share ``parent_session_id`` but are another conversation.
_FORK_MARKERS = ("_branched_from", "_delegate_from", "_reset_from")
# Set once, so a store the lineage walk can't read is loud on the first poll and quiet afterwards.
_walk_failed = False
ADJECTIVES = (
    "breezy", "cosmic", "dapper", "fuzzy", "gleaming", "jazzy", "lucky", "mellow", "nimble",
    "peppy", "quirky", "snazzy", "spry", "sunny", "swift", "wobbly", "zesty", "plucky",
)
NOUNS = (
    "badger", "biscuit", "comet", "dumpling", "falcon", "hopper", "lantern", "marmot", "noodle",
    "otter", "pickle", "puffin", "quokka", "sprocket", "thimble", "walrus", "waffle", "yeti",
)
GIT_TIMEOUT_S = 60
MUTATING_TOOLS = frozenset(
    {"write_file", "patch", "execute_code", "delegate_task", "pull_request", "library_add"}
)
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
PLANS_DIR = "plans"
# A plan-mode reply is saved only when it is a plan: the heading the instructions ask for.
PLAN_HEADING = "# Plan:"
# Where the session's generated files (screenshots, images, reports) are filed, under the project's
# primary folder, in a folder named after the session's worktree. The library_add tool makes it.
FILES_DIR = "files"
LIVE_STATUSES = {
    "queued": "running",
    "running": "running",
    "stopping": "running",
    "waiting_for_approval": "waiting_for_approval",
}

# The dashboard shows a session's source as its label. /api/sessions only accepts a fixed set of
# sources, so Gots's sessions start as the API server's and the plugin relabels them.
SESSION_SOURCE = "Gots"
CODE_SESSION_SOURCE = "Gots Code"
RELABELLED_SOURCES = ("api_server", "unknown")
# What earlier plugin versions wrote (as Memento, and before that under the lower-case id);
# still ours to upgrade.
CHAT_LEGACY_SOURCES = ("memento", "Memento")
CODE_LEGACY_SOURCES = ("memento-code", "Memento Code")
# How the app starts the session ids of its chats (`createConversation`).
MEMENTO_ID_PREFIX = "memento-"

# The API server adapter, kept by _wire_api_server so the hooks can reach its session store.
adapter: Any = None


class WorkspaceError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _record(row: Any) -> Dict[str, Any]:
    record = dict(zip(FIELDS, row))
    record["plan_pending"] = bool(record["plan_pending"])
    record["mode"] = LEGACY_MODES.get(record["mode"], record["mode"])
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


def _open_state(home: Path) -> Optional[sqlite3.Connection]:
    """A read-only look at the profile's ``state.db``, or None when it has none.

    Read-only, so a reader can never lock the gateway out of its own store. Closed by the caller
    (or ``closing``): a poll opens one of these per request.
    """
    state = home / "state.db"
    if not state.exists():
        return None
    try:
        conn = sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2)
    except sqlite3.Error:
        logger.debug("memento: couldn't open %s", state, exc_info=True)
        return None
    conn.row_factory = sqlite3.Row
    return conn


def _parent_of(hermes_home: Path, session_id: str) -> Optional[str]:
    conn = _open_state(hermes_home)
    if conn is None:
        return None
    try:
        with closing(conn):
            row = conn.execute(
                "SELECT parent_session_id FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row and isinstance(row[0], str) and row[0] else None


def record_of(path: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """The session's own record: what the app reads its workspace — and its pending plan — from.

    Never ``record_for``: a record reached through the parent walk is another session's, and the
    app would take that session's ``plan_pending``/``plan_file`` for this one's, show its plan
    here and approve its file. The walk stays where a chat's own id has to find its worktree: the
    hooks (see ``record_for_call``).
    """
    return read(path, session_id)


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


def record_for_call(
    path: Path, hermes_home: Path, task_id: Optional[str], session_id: Optional[str]
) -> Optional[Dict[str, Any]]:
    """The session a tool call belongs to: its task id is Gots's session id, and a call can
    carry either. Each key is tried once (they are the same one on this surface); a compressed
    session's child id walks to the parent record, like ``record_for``."""
    if not path.exists():
        return None
    for key in dict.fromkeys(key for key in (task_id, session_id) if key):
        record = record_for(path, hermes_home, key)
        if record:
            return record
    return None


def slug(task: Any = None) -> str:
    """A worktree name of two random words and a few hex digits, so two never clash."""
    return f"{secrets.choice(ADJECTIVES)}-{secrets.choice(NOUNS)}-{secrets.token_hex(2)}"


def _project(projects_db: Path, project_id: str) -> Any:
    project = projects(projects_db).get(project_id)
    if project is None:
        raise ValueError("No such project.")
    return project


def projects(projects_db: Path) -> Dict[str, Any]:
    """Every project by id, read once: a caller sweeping many projects needs one list, not one each."""
    from hermes_cli import projects_db as pdb

    if not projects_db.exists():
        return {}
    with pdb.connect_closing(db_path=projects_db) as conn:
        found = pdb.list_projects(conn, include_archived=True)
    return {str(project.id): project for project in found}


def _project_folders(project: Any) -> list[str]:
    """The project's folders as absolute paths, primary first."""
    folders = sorted(project.folders, key=lambda folder: not folder.is_primary)
    return [os.path.abspath(os.path.expanduser(folder.path)) for folder in folders]


def _git_folders(project: Any) -> list[str]:
    """The project's git folders, primary first."""
    repos = []
    for root in _project_folders(project):
        if os.path.exists(os.path.join(root, ".git")) and root not in repos:
            repos.append(root)
    return repos


def _blocked(project: Any, record: Optional[Dict[str, Any]]) -> Optional[str]:
    if getattr(project, "archived", False):
        return "This project is archived."
    if not record:
        return None
    roots = _git_folders(project)
    gone = [repo["name"] for repo in record["repos"] if repo["repo_root"] not in roots]
    if gone:
        names = " and ".join(gone)
        return f"{names} {'was' if len(gone) == 1 else 'were'} removed from this project."
    return None


def blocked(hermes_home: Path, record: Optional[Dict[str, Any]]) -> Optional[str]:
    """Why the session can't take another turn: its project is archived, or a repo it works in was
    removed from the project. None when it can."""
    if not record:
        return None
    try:
        project = _project(hermes_home / "projects.db", record["project_id"])
    except ValueError:
        return "This project was deleted."
    except ImportError:
        return None
    return _blocked(project, record)


def _fetch_origin(repo_root: str, auth: Optional[str] = None) -> None:
    """Best-effort fetch so a new worktree branches from the latest remote tip, not a stale
    local ref. _setup_worktree's own fetch has a short timeout and a freshness window that can
    skip it; this runs first with the plugin's longer timeout. Never raises — offline or auth
    failures fall through to _setup_worktree's cached ref or the local-HEAD fallback.

    The token is passed via ``http.extraheader`` (not saved in .git/config) so private repos
    accept the fetch."""
    from . import github

    args = [*github.git_auth_args(auth), "fetch", "origin", "--prune"]
    try:
        result = _git(repo_root, *args)
        if result.returncode != 0:
            logger.debug("memento: fetch origin in %s failed: %s", repo_root, result.stderr.strip())
    except WorkspaceError:
        logger.debug("memento: fetch origin in %s failed", repo_root, exc_info=True)


def _create_worktree(repo_root: str, name: str, auth: Optional[str] = None) -> Dict[str, str]:
    from hermes_cli.worktree_ops import _setup_worktree

    _fetch_origin(repo_root, auth)
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


def _upsert(
    path: Path,
    session_id: str,
    project_id: str,
    repos: list[Dict[str, str]],
    mode: str,
    files_dir: Optional[str],
):
    first = repos[0]
    conn = connect(path)
    try:
        conn.execute(
            """INSERT INTO project_sessions
                   (session_id, project_id, repo_root, path, branch, mode, plan_pending, created_at, repos, files_dir)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
               ON CONFLICT(session_id) DO UPDATE SET
                   project_id = excluded.project_id, repo_root = excluded.repo_root,
                   path = excluded.path, branch = excluded.branch, mode = excluded.mode,
                   plan_pending = 0, repos = excluded.repos, files_dir = excluded.files_dir""",
            (
                session_id,
                project_id,
                first["repo_root"],
                first["path"],
                first["branch"],
                mode,
                int(time.time() * 1000),
                json.dumps(repos, separators=(",", ":")),
                files_dir,
            ),
        )
    finally:
        conn.close()
    return read(path, session_id)


def _fill_library_folder(path: Path, record: Dict[str, Any], project: Any) -> Dict[str, Any]:
    """Fills the library folder on a session row written before the column existed, so the run's
    instructions name it and the tool doesn't resolve it from the project on every call."""
    if record.get("files_dir") or not record.get("repos"):
        return record
    folder = files_dir(project, record["repos"][0]["branch"])
    conn = connect(path)
    try:
        conn.execute(
            "UPDATE project_sessions SET files_dir = ? WHERE session_id = ?",
            (folder, record["session_id"]),
        )
    finally:
        conn.close()
    record["files_dir"] = folder
    return record


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
    if mode is not None and LEGACY_MODES.get(mode, mode) not in MODES:
        raise ValueError("mode must be accept_edits, auto or plan.")
    if task is not None and not isinstance(task, str):
        raise ValueError("task must be a string.")
    project_id = str(project_id).strip()
    project = _project(hermes_home / "projects.db", project_id)
    record = read(path, session_id)
    reason = _blocked(project, record)
    if reason:
        raise WorkspaceError(reason, 409)
    if not record:
        from . import repos as repo_changes

        if repo_changes.cloning(hermes_home, project_id):
            raise WorkspaceError("A repository is still being added to this project.", 409)
    roots = _git_folders(project)
    if not roots:
        raise ValueError("This project has no git repository.")
    existing = {repo["repo_root"]: repo for repo in (record or {}).get("repos", [])}
    if record and all(root in existing and os.path.isdir(existing[root]["path"] or "") for root in roots):
        if mode and mode != record["mode"]:
            record = set_mode(path, session_id, mode)
        return _fill_library_folder(path, record, project)
    # One branch name across the repos; a later repo joins the name the first one got.
    name = next((repo["branch"].split("/", 1)[1] for repo in existing.values() if repo.get("branch")), None)
    name = name or slug(task)
    # Resolve the token once: the host's GitHub credential is the same for every repo.
    auth: Optional[str] = None
    try:
        from . import github

        auth, _ = github.token(hermes_home)
    except Exception:
        logger.debug("memento: couldn't resolve GitHub token for fetch", exc_info=True)
    repos = []
    for root in roots:
        kept = existing.get(root)
        if kept and os.path.isdir(kept["path"] or ""):
            repos.append(kept)
            continue
        tree = _create_worktree(root, name, auth)
        repos.append({"name": _repo_name(root), "repo_root": root, **tree})
    return _upsert(
        path,
        session_id,
        project_id,
        repos,
        mode or (record or {}).get("mode") or MODES[0],
        files_dir(project, repos[0]["branch"]),
    )


# Every pull request the plugin opens ends with it.
PR_FOOTER = "---\n\nGenerated by [Gots Code](https://hermesgots.dev), a Hermes plugin."


def _branch_slug(branch: Optional[str]) -> str:
    """``hermes/<slug>`` to ``<slug>``: the worktree's name, which plan and library files are named after."""
    name = branch.split("/", 1)[1] if branch and "/" in branch else (branch or "")
    return name or "session"


def plan_filename(record: Dict[str, Any], now: datetime) -> str:
    """``<branch slug>-<date>-<time>.md``: every plan of a session together, oldest first."""
    return f"{_branch_slug(record.get('branch'))}-{now:%Y%m%d-%H%M%S}.md"


def files_dir(project: Any, branch: Optional[str]) -> str:
    """``<primary folder>/files/<worktree slug>``: where the session's generated files are filed.

    Kept on the session's row so the run's instructions can name it without a projects.db read.
    """
    return str(Path(_project_folders(project)[0]) / FILES_DIR / _branch_slug(branch))


def _exclude_from_git(root: str, name: str) -> None:
    """Keeps ``name/`` out of ``git status`` when the project's folder is itself a repo."""
    if not os.path.isdir(os.path.join(root, ".git")):
        return
    exclude = Path(root) / ".git" / "info" / "exclude"
    line = f"{name}/"
    try:
        current = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        if line in current.splitlines():
            return
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a", encoding="utf-8") as handle:
            handle.write(("" if not current or current.endswith("\n") else "\n") + line + "\n")
    except OSError:
        logger.debug("memento: couldn't exclude %s from git in %s", name, root, exc_info=True)


def save_plan(path: Path, hermes_home: Path, record: Dict[str, Any], text: Any) -> Optional[str]:
    """Writes a plan-mode reply to ``<project folder>/plans/`` and remembers it on the session.
    Returns the file's path under the project folder, or None when the reply isn't a plan."""
    if not isinstance(text, str) or not any(
        line.startswith(PLAN_HEADING) for line in text.splitlines()
    ):
        return None
    project = _project(hermes_home / "projects.db", record["project_id"])
    root = _project_folders(project)[0]
    now = datetime.now().astimezone()
    name = plan_filename(record, now)
    folder = Path(root) / PLANS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    _exclude_from_git(root, PLANS_DIR)
    front_matter = "\n".join(
        [
            "---",
            f"session: {record['session_id']}",
            f"branch: {record.get('branch') or ''}",
            f"project: {json.dumps(getattr(project, 'name', '') or '')}",
            f"created: {now.isoformat(timespec='seconds')}",
            "---",
        ]
    )
    (folder / name).write_text(f"{front_matter}\n\n{text.strip()}\n", encoding="utf-8")
    plan_file = f"{PLANS_DIR}/{name}"
    conn = connect(path)
    try:
        conn.execute(
            "UPDATE project_sessions SET plan_file = ? WHERE session_id = ?",
            (plan_file, record["session_id"]),
        )
    finally:
        conn.close()
    return plan_file


def apply_cwd(session_id: str, cwd: str) -> None:
    """Points the session's terminal and file tools into its worktree. In memory only."""
    try:
        from tools.terminal_tool import register_task_env_overrides
    except ImportError:
        logger.debug("memento: this Hermes has no per-task cwd override")
        return
    register_task_env_overrides(session_id, {"cwd": cwd})


def _cwd(session_id: str) -> Optional[str]:
    try:
        from tools.terminal_tool import get_session_cwd
    except ImportError:
        return None
    return get_session_cwd(session_id) if session_id else None


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
    mode = LEGACY_MODES.get(mode, mode)
    if mode not in MODES:
        raise ValueError("mode must be accept_edits, auto or plan.")
    record = read(path, session_id)
    if not record:
        return None
    conn = connect(path)
    try:
        conn.execute(
            "UPDATE project_sessions SET mode = ?, plan_pending = 0 WHERE session_id = ?",
            (mode, session_id),
        )
    finally:
        conn.close()
    events.note("runs", session_id, path, True)
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
    events.note("runs", session_id, path, True)
    if pending:
        push.notify("plan", session_id, path)


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


def label(db: Any, session_id: str, code: bool = False) -> Optional[str]:
    """Marks a session as Gots's, so the Hermes dashboard labels it: ``Gots`` for a chat,
    ``Gots Code`` for a project session. Answers the session's source, or None when it isn't
    one the plugin may label."""
    source = CODE_SESSION_SOURCE if code else SESSION_SOURCE
    # A project session was a chat's source until its workspace existed; never the other way.
    from_sources = RELABELLED_SOURCES + CHAT_LEGACY_SOURCES
    if code:
        from_sources += (SESSION_SOURCE,) + CODE_LEGACY_SOURCES

    def write(conn):
        placeholders = ", ".join("?" for _ in from_sources)
        # Never takes a session from another surface (Telegram, the CLI, ...).
        cursor = conn.execute(
            f"UPDATE sessions SET source = ? WHERE id = ? AND source IN ({placeholders})",
            (source, session_id, *from_sources),
        )
        if cursor.rowcount:
            return source
        row = conn.execute("SELECT source FROM sessions WHERE id = ?", (session_id,)).fetchone()
        current = row[0] if row else None
        return current if current in (source, CODE_SESSION_SOURCE if code else None) else None

    return db._execute_write(write)


def is_code_session(session_id: str) -> bool:
    """Whether the session has a project workspace record."""
    path, _ = _paths()
    return bool(path.exists() and read(path, session_id))


def chat_session(
    home: Path, session_id: str, known: Optional[Dict[str, str]] = None
) -> str:
    """The session a chat started as. Compression moves a chat on to a child session, and Gots
    only knows the first, so a run Hermes keyed on the child has to be found from the root.

    A hop is taken only where the parent ended in compression and the child continues it rather
    than forking off it, which is Hermes's own test (``_non_continuation_child_sql``): a branch, a
    delegation, a reset or a tool session keeps its own id, so its run is never reported as the
    chat's.

    Reads ``state.db`` itself, read-only, rather than ``SessionDB.get_session``: the app polls
    ``runs/live`` every 10 s and the change stream walks this per session event, and ``get_session``
    drains the live turn's queued token writes, so every poll would stall behind the turn it is
    asked about (and the reads sharing the API server's executor with it). ``known`` memoises the
    walk for one request — every id it passed, since a chain answers one root.
    """
    if known is not None and session_id in known:
        return known[session_id]
    current = session_id
    walked = [session_id]
    conn = _open_state(home)
    if conn is not None:
        try:
            with closing(conn):
                for _ in range(COMPRESSION_DEPTH):
                    row = conn.execute(
                        """SELECT child.parent_session_id AS parent_id,
                                  parent.end_reason AS parent_end,
                                  child.model_config AS model_config,
                                  child.source AS source
                           FROM sessions child LEFT JOIN sessions parent
                             ON parent.id = child.parent_session_id
                           WHERE child.id = ?""",
                        (current,),
                    ).fetchone()
                    parent_id = row["parent_id"] if row else None
                    if (
                        not parent_id
                        or row["parent_end"] != "compression"
                        or parent_id in walked
                        or _forks(row, parent_id)
                    ):
                        break
                    current = parent_id
                    walked.append(current)
        except sqlite3.Error:
            # A store this can't read would key every run on its tip — the wedge this exists to
            # avoid — so say it once, loudly enough to find, and never cache the failure.
            global _walk_failed
            if not _walk_failed:
                _walk_failed = True
                logger.warning("memento: couldn't walk a chat's compression lineage", exc_info=True)
            return session_id
    if known is not None:
        for session in walked:
            known[session] = current
    return current


def _forks(row: Any, parent_id: str) -> bool:
    """Whether this child forks off its parent instead of continuing it: a session a tool made, or
    one Hermes marked with a parent id of its own. A marker naming another row is inherited from a
    continuation, not a fork of this parent (``_non_continuation_child_sql``)."""
    if (row["source"] or "") == "tool":
        return True
    try:
        config = json.loads(row["model_config"] or "{}")
    except ValueError:
        return False
    return isinstance(config, dict) and any(
        config.get(marker) == parent_id for marker in _FORK_MARKERS
    )


def live_runs(
    adapter: Any,
    owned: Optional[Callable[[str], bool]] = None,
    home: Optional[Path] = None,
    known: Optional[Dict[str, str]] = None,
) -> Tuple[Dict[str, str], Dict[str, str]]:
    """Each session with a run in flight: ``running`` or ``waiting_for_approval``, and its run id.

    The run id is what lets a client that lost track of a reply (a reload, a dropped stream) follow
    the run again. Keyed by the session the chat started as (``chat_session``), not the run's own:
    compression moves a chat on to a child session mid-flight, and a device that only knows the id
    the chat began with must still find its run. ``owned`` keeps only the runs the caller's profile
    started; ``home`` is that profile's, for the lineage walk, which ``known`` shares with
    ``waiting`` so one poll walks a chat once.
    """
    statuses = getattr(adapter, "_run_statuses", None)
    if not isinstance(statuses, dict):
        return {}, {}
    live: Dict[str, str] = {}
    run_ids: Dict[str, str] = {}
    known = {} if known is None else known
    for run_id, status in list(statuses.items()):
        if not isinstance(status, dict) or (owned and not owned(run_id)):
            continue
        state_name = LIVE_STATUSES.get(status.get("status"))
        session_id = status.get("session_id")
        if not state_name or not isinstance(session_id, str) or not session_id:
            continue
        if home is not None:
            session_id = chat_session(home, session_id, known)
        if live.get(session_id) != "waiting_for_approval":
            live[session_id] = state_name
            if isinstance(run_id, str):
                run_ids[session_id] = run_id
    return live, run_ids


def waiting(
    adapter: Any,
    path: Path,
    hermes_home: Path,
    owned: Optional[Callable[[str], bool]] = None,
    known: Optional[Dict[str, str]] = None,
) -> Dict[str, Dict[str, Any]]:
    """Why each session waits on the user: its run's questions or approval, or a plan to review.
    A project session also names its project. Keyed by the session the chat started as, like
    ``live_runs``, so a wait on a compressed chat's child session is reported for the chat; its
    ``known`` cache is the one that call filled, so a poll walks each chat once."""
    found: Dict[str, Dict[str, Any]] = {}
    statuses = getattr(adapter, "_run_statuses", None)
    known = {} if known is None else known
    for run_id, status in list(statuses.items()) if isinstance(statuses, dict) else []:
        if not isinstance(status, dict) or status.get("status") != "waiting_for_approval":
            continue
        if owned and not owned(run_id):
            continue
        session_id = status.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            continue
        session_id = chat_session(hermes_home, session_id, known)
        clarify = status.get("clarify")
        if isinstance(clarify, dict):
            questions = clarify.get("questions")
            count = len(questions) if isinstance(questions, list) and questions else 1
            found[session_id] = {"kind": "question", "count": count}
            continue
        approval = status.get("approval")
        command = approval.get("command") if isinstance(approval, dict) else None
        reason: Dict[str, Any] = {"kind": "approval"}
        if isinstance(command, str) and command.strip():
            reason["command"] = command.strip()
        found.setdefault(session_id, reason)
    if not path.exists():
        return found
    conn = connect(path)
    try:
        rows = conn.execute(f"SELECT {', '.join(FIELDS)} FROM project_sessions").fetchall()
    finally:
        conn.close()
    records = {record["session_id"]: record for record in map(_record, rows)}
    for session_id, record in records.items():
        if record["plan_pending"]:
            found.setdefault(session_id, {"kind": "plan"})
    names = _project_names(hermes_home) if any(s in records for s in found) else {}
    for session_id, reason in found.items():
        record = records.get(session_id)
        if record and names.get(record["project_id"]):
            reason["project"] = names[record["project_id"]]
    return found


def _project_names(hermes_home: Path) -> Dict[str, str]:
    projects_db = hermes_home / "projects.db"
    try:
        from hermes_cli import projects_db as pdb

        if not projects_db.exists():
            return {}
        with pdb.connect_closing(db_path=projects_db) as conn:
            return {str(p.id): p.name for p in pdb.list_projects(conn, include_archived=True)}
    except Exception:
        logger.debug("memento: couldn't read project names", exc_info=True)
        return {}


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
    record = record_for_call(path, home, task_id, session_id)
    if not record:
        return None
    if record["path"] and task_id and not _has_cwd(task_id):
        # The gateway restarted since the app last posted the workspace.
        apply_cwd(task_id, record["path"])
    # A goal continues a session's turn on its own, so the run stays in Auto.
    follow_auto(record["mode"] == "auto")
    if record["mode"] != "plan":
        return None
    tool = kwargs.get("tool_name")
    args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
    if tool in MUTATING_TOOLS or (tool == "terminal" and not read_only(args.get("command"))):
        return {"action": "block", "message": PLAN_BLOCK}
    return None


def follow_auto(auto: bool) -> None:
    """Switches Hermes's own approval bypass for the run this tool call belongs to (its approval key
    is the run id) to match the session's mode, so Auto needs no app to answer. The bypass skips
    the prompt only: the hardline blocklist is checked first and still blocks. Runs before every
    tool call, so a mode change made mid-run takes effect on the next one."""
    try:
        from tools.approval import (
            disable_session_yolo,
            enable_session_yolo,
            is_session_yolo_enabled,
        )
        from tools.approval_context import get_current_session_key
    except ImportError:
        logger.debug("memento: this Hermes has no per-session approval bypass")
        return
    key = get_current_session_key(default="")
    if not key or key == "default" or is_session_yolo_enabled(key) == auto:
        return
    (enable_session_yolo if auto else disable_session_yolo)(key)


def answer_waiting(session_id: str) -> int:
    """Approves, once, the dangerous commands this session's runs are already waiting on, for a
    session that has just been switched to Auto. A guardian's DENY is left for the user. Returns
    how many requests were answered."""
    statuses = getattr(adapter, "_run_statuses", None)
    if not isinstance(statuses, dict):
        return 0
    try:
        from tools.approval import list_gateway_approvals, resolve_gateway_approval
    except ImportError:
        return 0
    answered = 0
    for run_id, status in list(statuses.items()):
        if not isinstance(status, dict) or status.get("session_id") != session_id:
            continue
        if status.get("status") != "waiting_for_approval":
            continue
        if any(entry.get("smart_denied") for entry in list_gateway_approvals(run_id)):
            continue
        count = resolve_gateway_approval(run_id, "once", resolve_all=True)
        # Hermes's own route would tell the run's clients; this answer has to do it itself.
        if count:
            approvals.announce(run_id, "once")
        answered += count
    return answered


def before_llm(**kwargs: Any) -> None:
    """The ``pre_llm_call`` hook: a new turn means the user answered the pending plan."""
    try:
        path, home = _paths()
        record = path.exists() and record_for(path, home, kwargs.get("session_id") or "")
        if record and record["plan_pending"]:
            set_plan_pending(path, record["session_id"], False)
    except Exception:
        logger.debug("memento: pre_llm_call failed", exc_info=True)


def started(**kwargs: Any) -> None:
    """The ``on_session_start`` hook: labels a brand-new session as Gots's when it is one
    (``Gots Code`` for a project session). Gots mints its chats' session ids (``memento-…``),
    and a project session has its workspace before its first turn."""
    try:
        session_id = kwargs.get("session_id") or ""
        # ``adapter._session_db`` is an explicit override (tests/manual wiring); in normal
        # operation the adapter caches per-profile SessionDBs and exposes them here.
        ensure = getattr(adapter, "_ensure_session_db", None)
        db = ensure() if callable(ensure) else getattr(adapter, "_session_db", None)
        if not session_id or db is None:
            return
        code = is_code_session(session_id)
        if not code and not session_id.startswith(MEMENTO_ID_PREFIX):
            return
        label(db, session_id, code)
    except Exception:
        logger.debug("memento: on_session_start failed", exc_info=True)


def after_llm(**kwargs: Any) -> None:
    """The ``post_llm_call`` hook: a plan-mode reply that is a plan goes into the project's plans
    folder. Hermes doesn't fire it for interrupted turns, so no half-written plan is saved."""
    try:
        path, home = _paths()
        if not path.exists():
            return
        task_id = kwargs.get("task_id") or ""
        session_id = kwargs.get("session_id") or ""
        record = record_for(path, home, session_id)
        if not record and task_id and task_id != session_id:
            record = record_for(path, home, task_id)
        if record and record["mode"] == "plan":
            save_plan(path, home, record, kwargs.get("assistant_response"))
    except Exception:
        logger.debug("memento: post_llm_call failed", exc_info=True)


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
    except Exception:
        logger.debug("memento: on_session_end failed", exc_info=True)
