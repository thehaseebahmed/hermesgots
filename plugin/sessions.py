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
change anything) and every device sees the same mode. A finished plan-mode reply is saved as a
Markdown file under the project's ``plans/`` folder, named after the session branch and the time.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

from . import events, push
from .store import connect

logger = logging.getLogger(__name__)

MODES = ("accept_edits", "auto", "plan", "theseus")
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
    "theseus",
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
MUTATING_TOOLS = frozenset({"write_file", "patch", "execute_code", "delegate_task", "open_pull_request"})
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
# primary folder, in a folder named after the session's worktree. The add_to_library tool makes it.
FILES_DIR = "files"
# Added to the run's instructions in plan mode. Fixed per mode, so the prompt cache holds across
# the turns of one mode. The app's mock repeats it; keep them the same.
PLAN_INSTRUCTIONS = """You are in plan mode: change nothing. Read what you need. Then, before you write the plan, settle every choice the user would otherwise be left to make: ask with the clarify tool, every question in one call, your recommended answer first. If you can't ask (no clarify tool, or no answer came), decide it yourself and record the decision under Risks and assumptions. Then make your whole final reply the plan below and stop; the user approves it before you act. It is saved to a file as written, so write it for someone who hasn't read this chat, and a plan with an open question isn't finished. Use this Markdown shape exactly:

# Plan: <short title>

## Overview
What was asked, the problem it solves and the outcome, in two to five sentences.

## Approach
The design you chose and why. One line each for the alternatives you rejected.

## Changes
One entry per file or area: its path, what changes and why, and the existing functions you'd reuse.

## Checkpoints
Split the work into checkpoints that each leave the code building and worth committing, in order. For each:
### Checkpoint N: <name>
- Commit: `type(scope): summary` in Conventional Commits form, unless the user asked for another style
- Steps: the concrete edits
- Done when: how you'd know it works

## Verification
How to test the whole change end to end: commands, what to look at, expected results.

## Risks and assumptions
What could go wrong, and each decision you made without the user: what you chose and why. Nothing here is left for the user to decide."""
LIVE_STATUSES = {
    "queued": "running",
    "running": "running",
    "stopping": "running",
    "waiting_for_approval": "waiting_for_approval",
}

# The dashboard shows a session's source as its label. /api/sessions only accepts a fixed set of
# sources, so Memento's sessions start as the API server's and the plugin relabels them.
SESSION_SOURCE = "Memento"
CODE_SESSION_SOURCE = "Memento Code"
RELABELLED_SOURCES = ("api_server", "unknown")
# What earlier plugin versions wrote; both are still ours to upgrade.
LEGACY_SOURCES = ("memento", "memento-code")
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
    try:
        settings = json.loads(record["theseus"]) if record["theseus"] else {}
    except ValueError:
        settings = {}
    record["theseus"] = settings if isinstance(settings, dict) else {}
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


def _project(projects_db: Path, project_id: str) -> Any:
    from hermes_cli import projects_db as pdb

    if not projects_db.exists():
        raise ValueError("No such project.")
    with pdb.connect_closing(db_path=projects_db) as conn:
        projects = pdb.list_projects(conn, include_archived=True)
    project = next((p for p in projects if str(p.id) == project_id), None)
    if project is None:
        raise ValueError("No such project.")
    return project


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


def _fetch_origin(repo_root: str) -> None:
    """Best-effort fetch so a new worktree branches from the latest remote tip, not a stale
    local ref. _setup_worktree's own fetch has a short timeout and a freshness window that can
    skip it; this runs first with the plugin's longer timeout. Never raises — offline or auth
    failures fall through to _setup_worktree's cached ref or the local-HEAD fallback."""
    try:
        result = _git(repo_root, "fetch", "origin", "--prune")
        if result.returncode != 0:
            logger.debug("memento: fetch origin in %s failed: %s", repo_root, result.stderr.strip())
    except WorkspaceError:
        logger.debug("memento: fetch origin in %s failed", repo_root, exc_info=True)


def _create_worktree(repo_root: str, name: str) -> Dict[str, str]:
    from hermes_cli.worktree_ops import _setup_worktree

    _fetch_origin(repo_root)
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
    files_dir: str,
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
        raise ValueError("mode must be accept_edits, auto, plan or theseus.")
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
    return _upsert(
        path,
        session_id,
        project_id,
        repos,
        mode or (record or {}).get("mode") or MODES[0],
        files_dir(project, repos[0]["branch"]),
    )


# Every pull request the plugin opens ends with it.
PR_FOOTER = "---\n\nGenerated by [Memento Code](https://memento.thehaseebahmed.com), a Hermes plugin."
# Added whenever a session has worktrees. Fixed text, so the prompt cache holds.
PR_INSTRUCTIONS = (
    "When the work is done and you've checked it, ship it yourself with the open_pull_request tool: "
    "it commits what's left, pushes this branch and opens a pull request, or updates the open one. "
    "Don't ask first, and don't use git push or gh for it. Write the description from the repo's "
    "pull request template when it has one (named below), else with Summary, Changes and How to "
    "test sections."
)
# The same condition as PR_INSTRUCTIONS: only code sessions get it.
DONE_INSTRUCTIONS = (
    "Two things the run's prompt emphasises once the work is done: don't share the pull request url "
    "or the commit message in your reply — the open_pull_request result and the session's pull "
    "request list already surface them where the user sees them. And before you finish, update your "
    "todo list to its final state: every item completed, or cancelled where it was dropped."
)


def instructions(record: Dict[str, Any]) -> str:
    """What the run's system prompt tells the agent: its worktrees (fixed per session), how to open
    its pull request and the repos' templates and, in plan mode, the shape of the plan."""
    worktrees = _worktree_line(record)
    lines = [
        worktrees,
        PR_INSTRUCTIONS if worktrees else "",
        DONE_INSTRUCTIONS if worktrees else "",
        _template_line(record),
    ]
    if record.get("mode") == "plan":
        lines.append(PLAN_INSTRUCTIONS)
    if record.get("mode") == "theseus":
        from . import theseus

        lines.append(theseus.instructions(record))
    return "\n".join(line for line in lines if line)


def _worktree_line(record: Dict[str, Any]) -> str:
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


def _template_line(record: Dict[str, Any]) -> str:
    from .ship import template

    found = [(repo["name"], template(repo.get("path"))) for repo in record.get("repos") or []]
    found = [(name, path) for name, path in found if path]
    if not found:
        return ""
    if len(record.get("repos") or []) == 1:
        return f"Its pull request template is {found[0][1]}."
    return "Pull request templates: " + "; ".join(f"{name}: {path}" for name, path in found) + "."


def _branch_slug(branch: Optional[str]) -> str:
    """``hermes/<slug>`` to ``<slug>``: the worktree's name, which plan and library files are named after."""
    name = branch.split("/", 1)[1] if branch and "/" in branch else (branch or "")
    return name or "session"


def plan_filename(record: Dict[str, Any], now: datetime) -> str:
    """``<branch slug>-<date>-<time>.md``: every plan of a session together, oldest first."""
    return f"{_branch_slug(record.get('branch'))}-{now:%Y%m%d-%H%M%S}.md"


def files_dir(project: Any, branch: Optional[str]) -> str:
    """``<primary folder>/files/<worktree slug>``: where the session's generated files are filed."""
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


def _record_cwd(session_id: str, cwd: Optional[str]) -> None:
    """Moves the session's current folder, as a ``cd`` would; its registered worktree stays."""
    if not cwd:
        return
    try:
        from tools.terminal_tool import record_session_cwd
    except ImportError:
        return
    record_session_cwd(session_id, cwd)


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
    if mode not in MODES:
        raise ValueError("mode must be accept_edits, auto, plan or theseus.")
    record = read(path, session_id)
    if not record:
        return None
    if mode != record["mode"] and "theseus" in (mode, record["mode"]):
        # A Theseus run is the whole session, from its first turn to its last.
        raise WorkspaceError(
            "A Theseus session keeps its mode." if record["mode"] == "theseus"
            else "Theseus can only start a new session.",
            409,
        )
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


def set_theseus(path: Path, session_id: str, models: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Keeps a Theseus session's reviewer models (see ``theseus.clean_models``)."""
    record = read(path, session_id)
    if not record or record["mode"] != "theseus":
        return None
    conn = connect(path)
    try:
        conn.execute(
            "UPDATE project_sessions SET theseus = ? WHERE session_id = ?",
            (json.dumps({**record["theseus"], "models": models}, separators=(",", ":")), session_id),
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
    from . import theseus

    folder = theseus.session_folder(record, path.parent.parent)
    if folder:
        shutil.rmtree(folder, ignore_errors=True)
    _delete(path, session_id)
    return {"removed": True, "kept": []}


def label(db: Any, session_id: str, code: bool = False) -> Optional[str]:
    """Marks a session as Memento's, so the Hermes dashboard labels it: ``Memento`` for a chat,
    ``Memento Code`` for a project session. Answers the session's source, or None when it isn't
    one the plugin may label."""
    source = CODE_SESSION_SOURCE if code else SESSION_SOURCE
    # A project session was a chat's source until its workspace existed; never the other way.
    from_sources = RELABELLED_SOURCES + LEGACY_SOURCES[:1]
    if code:
        from_sources += (SESSION_SOURCE, LEGACY_SOURCES[1])

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


def live_runs(
    adapter: Any, owned: Optional[Callable[[str], bool]] = None
) -> Tuple[Dict[str, str], Dict[str, str]]:
    """Each session with a run in flight: ``running`` or ``waiting_for_approval``, and its run id.

    The run id is what lets a client that lost track of a reply (a reload, a dropped stream) follow
    the run again. ``owned`` keeps only the runs the caller's profile started.
    """
    statuses = getattr(adapter, "_run_statuses", None)
    if not isinstance(statuses, dict):
        return {}, {}
    live: Dict[str, str] = {}
    run_ids: Dict[str, str] = {}
    for run_id, status in list(statuses.items()):
        if not isinstance(status, dict) or (owned and not owned(run_id)):
            continue
        state = LIVE_STATUSES.get(status.get("status"))
        session_id = status.get("session_id")
        if not state or not isinstance(session_id, str) or not session_id:
            continue
        if live.get(session_id) != "waiting_for_approval":
            live[session_id] = state
            if isinstance(run_id, str):
                run_ids[session_id] = run_id
    return live, run_ids


def waiting(
    adapter: Any, path: Path, hermes_home: Path, owned: Optional[Callable[[str], bool]] = None
) -> Dict[str, Dict[str, Any]]:
    """Why each session waits on the user: its run's questions or approval, or a plan to review.
    A project session also names its project."""
    found: Dict[str, Dict[str, Any]] = {}
    statuses = getattr(adapter, "_run_statuses", None)
    for run_id, status in list(statuses.items()) if isinstance(statuses, dict) else []:
        if not isinstance(status, dict) or status.get("status") != "waiting_for_approval":
            continue
        if owned and not owned(run_id):
            continue
        session_id = status.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            continue
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
        elif session_id not in found and record["mode"] == "theseus":
            from . import theseus

            # Its run is in `theseus wait` (so the turn is still running); the user is who it waits on.
            at = theseus.waiting_stage(record)
            if at:
                found[session_id] = {"kind": "theseus", "stage": at}
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
    # A Theseus session runs in Auto: the user's say is on the run's checkpoints, not on commands.
    follow_auto(record["mode"] in ("auto", "theseus"))
    if record["mode"] == "theseus":
        from . import alerts, theseus

        args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
        alerts.theseus_tool(path, record, kwargs.get("tool_name"), args)
        if theseus.blocks_record(kwargs.get("tool_name"), args):
            return {"action": "block", "message": theseus.THESEUS_BLOCK}
        misplaced = theseus.misplaced_init(kwargs.get("tool_name"), args, record, _cwd(task_id))
        if misplaced:
            return {"action": "block", "message": misplaced}
        if kwargs.get("tool_name") == "delegate_task" and task_id:
            # A child starts in the parent's current folder, and the run may live in another repo
            # of the session (or above them), where the planner has to work.
            _record_cwd(task_id, theseus.run_home(record))
        return None
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
        answered += resolve_gateway_approval(run_id, "once", resolve_all=True)
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
    """The ``on_session_start`` hook: labels a brand-new session as Memento's when it is one
    (``Memento Code`` for a project session). Memento mints its chats' session ids (``memento-…``),
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
