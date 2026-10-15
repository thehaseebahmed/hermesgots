"""Shipping a project session's work: the agent's ``open_pull_request`` tool commits what's left in
each worktree, pushes the branch and opens a pull request (or updates the open one), on the Hermes
host with its GitHub account (``github.py``), so the agent never needs the token or ``gh``. Closing a
session (discarded or deleted in the app) closes its pull requests and deletes its pushed branches.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import github, projects, tools_common
from .sessions import PR_FOOTER, WorkspaceError, _git

logger = logging.getLogger(__name__)

MAX_MESSAGE = 4000
MAX_TITLE = 256
MAX_BODY = 60000

_locks: Dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class ShipError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _count(tree: str, *args: str) -> Optional[int]:
    result = _git(tree, "rev-list", "--count", *args)
    try:
        return int(result.stdout.strip()) if result.returncode == 0 else None
    except ValueError:
        return None


def _has_ref(tree: str, ref: str) -> bool:
    return _git(tree, "rev-parse", "--verify", "-q", ref).returncode == 0


def _repo_status(repo: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    tree = repo.get("path")
    if not tree or not os.path.isdir(tree):
        return None
    status = _git(tree, "status", "--porcelain")
    if status.returncode != 0:
        return None
    base = projects._base_branch(repo["repo_root"])
    # Commits the branch adds to its base, and commits no remote holds yet (all of them when the
    # repo has no remote, which is why a push then fails with the reason).
    ahead = _count(tree, f"origin/{base}..HEAD") if base and _has_ref(tree, f"origin/{base}") else None
    unpushed = _count(tree, "HEAD", "--not", "--remotes")
    return {
        "name": repo["name"],
        "branch": repo["branch"],
        "base": base,
        "changed": len([line for line in status.stdout.splitlines() if line.strip()]),
        "ahead": ahead if ahead is not None else unpushed or 0,
        "unpushed": unpushed or 0,
        "pushed": _has_ref(tree, f"refs/remotes/origin/{repo['branch']}"),
    }


def status(record: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each worktree's uncommitted files, commits ahead of its base and commits not yet pushed."""
    return [found for repo in (record or {}).get("repos", []) if (found := _repo_status(repo))]


def _text(value: Any, name: str, limit: int) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string.")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"{name} is too long.")
    return value or None


def _identity_env(hermes_home: Path, tree: str) -> Dict[str, str]:
    """The host's git identity, else the GitHub account's no-reply address, so a commit never
    stops on "Please tell me who you are"."""
    if _git(tree, "config", "user.email").stdout.strip() and _git(tree, "config", "user.name").stdout.strip():
        return {}
    auth, _ = github.token(hermes_home)
    user = None
    if auth:
        try:
            user = github._get("/user", auth)
        except github.GitHubError:
            user = None
    login = user.get("login") if isinstance(user, dict) else None
    if not isinstance(login, str) or not login:
        raise ShipError("Set a git user.name and user.email on the server to commit.", 409)
    name = user.get("name") if isinstance(user.get("name"), str) and user.get("name") else login
    email = f"{user['id']}+{login}@users.noreply.github.com" if isinstance(user.get("id"), int) else f"{login}@users.noreply.github.com"
    return {
        "GIT_AUTHOR_NAME": name,
        "GIT_AUTHOR_EMAIL": email,
        "GIT_COMMITTER_NAME": name,
        "GIT_COMMITTER_EMAIL": email,
    }


def _run(tree: str, args: List[str], env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["git", "-C", tree, *args],
            capture_output=True,
            text=True,
            timeout=120,
            stdin=subprocess.DEVNULL,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})},
        )
    except FileNotFoundError:
        raise ShipError("git isn't installed on the server.", 501) from None
    except subprocess.TimeoutExpired:
        raise ShipError("git took too long.", 504) from None


def _last_line(text: str, fallback: str, secret: Optional[str] = None) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    message = lines[-1] if lines else fallback
    return message.replace(secret, "***") if secret else message


def _commit(hermes_home: Path, tree: str, message: str) -> str:
    env = _identity_env(hermes_home, tree)
    added = _run(tree, ["add", "-A"])
    if added.returncode != 0:
        raise ShipError(_last_line(added.stderr, "git add failed."))
    committed = _run(tree, ["commit", "-q", "-m", message], env)
    if committed.returncode != 0:
        raise ShipError(_last_line(committed.stderr or committed.stdout, "git commit failed."))
    return _git(tree, "rev-parse", "--short", "HEAD").stdout.strip()


def _push(hermes_home: Path, tree: str, branch: str) -> None:
    auth, _ = github.token(hermes_home)
    command = github.git_auth_args(auth)
    pushed = _run(tree, [*command, "push", "-u", "origin", f"HEAD:refs/heads/{branch}"])
    if pushed.returncode != 0:
        stderr = pushed.stderr
        if "could not read Username" in stderr or "Authentication failed" in stderr or "403" in stderr:
            raise ShipError("GitHub refused the push. Check the server's GitHub account.", 403)
        raise ShipError(_last_line(stderr, "git push failed.", auth))


def _body(tree: str, base: Optional[str], body: Optional[str]) -> str:
    if not body:
        log = _git(tree, "log", "--reverse", "--format=- %s", f"origin/{base}..HEAD") if base else None
        body = log.stdout.strip() if log is not None and log.returncode == 0 else ""
    if PR_FOOTER in body:
        return body
    return f"{body}\n\n{PR_FOOTER}" if body else PR_FOOTER


def _open_pr(
    hermes_home: Path, repo: Dict[str, Any], state: Dict[str, Any], title: Optional[str], body: Optional[str], draft: bool
) -> Dict[str, Any]:
    name = github.origin_repo(repo["repo_root"])
    if not name:
        raise ShipError("The repo's origin isn't on GitHub.", 409)
    if not state["base"]:
        raise ShipError("Couldn't tell which branch to open the pull request against.", 409)
    auth, _ = github.token(hermes_home)
    if not auth:
        raise ShipError("No GitHub account on the server.", 409)
    tree = repo["path"]
    if not title:
        subjects = _git(tree, "log", "--format=%s", f"origin/{state['base']}..HEAD").stdout.splitlines()
        title = subjects[0] if len(subjects) == 1 else repo["branch"]
    try:
        created = github.create_pull_request(
            name, repo["branch"], state["base"], title[:MAX_TITLE], _body(tree, state["base"], body), draft, auth
        )
    except github.GitHubError as error:
        raise ShipError(str(error), error.status) from None
    github.forget_pull_request(repo["repo_root"], repo["branch"])
    return created


def _lock(session_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(session_id, threading.Lock())


def ship(
    hermes_home: Path,
    session_id: str,
    record: Dict[str, Any],
    message: Any,
    title: Any,
    body: Any,
    draft: Any,
    open_pr: Any,
) -> List[Dict[str, Any]]:
    """Commits each worktree's changes with ``message``, pushes its branch and, with ``open_pr``,
    opens a pull request where the branch has none open. One result per repo that had work; a
    repo's failure doesn't stop the others."""
    message = _text(message, "message", MAX_MESSAGE)
    title = _text(title, "title", MAX_TITLE)
    body = _text(body, "body", MAX_BODY)
    if draft is not None and not isinstance(draft, bool):
        raise ValueError("draft must be true or false.")
    if open_pr is not None and not isinstance(open_pr, bool):
        raise ValueError("pr must be true or false.")
    lock = _lock(session_id)
    if not lock.acquire(blocking=False):
        raise ShipError("This session's changes are already being pushed.", 409)
    try:
        states = {state["name"]: state for state in status(record)}
        if not message and any(state["changed"] for state in states.values()):
            raise ValueError("A commit message is required.")
        results = []
        for repo in record["repos"]:
            state = states.get(repo["name"])
            if not state:
                continue
            existing = github.pull_request(hermes_home, repo["repo_root"], repo["branch"], fresh=True)
            live_pr = existing if existing and existing["state"] in ("open", "draft") else None
            # After a merged or closed pull request only new work makes another: a squash-merged
            # branch still counts its old commits as ahead.
            new_work = state["changed"] or state["unpushed"]
            wants_pr = bool(open_pr) and not live_pr and (new_work or (not existing and state["ahead"]))
            if not (state["changed"] or state["unpushed"] or wants_pr):
                continue
            result: Dict[str, Any] = {"name": repo["name"], "committed": None, "pushed": False, "pr": live_pr}
            try:
                if state["changed"]:
                    result["committed"] = _commit(hermes_home, repo["path"], message)
                    state = _repo_status(repo) or state
                if state["unpushed"] or not state["pushed"]:
                    _push(hermes_home, repo["path"], repo["branch"])
                    result["pushed"] = True
                if wants_pr:
                    result["pr"] = _open_pr(hermes_home, repo, state, title, body, bool(draft))
            except (ShipError, WorkspaceError) as error:
                result["error"] = str(error)
            results.append(result)
        return results
    finally:
        lock.release()


TEMPLATES = (
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
)
# What a pull request's body follows when its repo has no template of its own.
DEFAULT_TEMPLATE = "## Summary\n\n## Changes\n\n## How to test"


def template(tree: Optional[str]) -> Optional[str]:
    """The repo's pull request template, relative to the worktree, when it has one."""
    if not tree:
        return None
    for name in TEMPLATES:
        if os.path.isfile(os.path.join(tree, name)):
            return name
    folder = os.path.join(tree, ".github", "PULL_REQUEST_TEMPLATE")
    try:
        found = sorted(f for f in os.listdir(folder) if f.lower().endswith(".md"))
    except OSError:
        return None
    return f".github/PULL_REQUEST_TEMPLATE/{found[0]}" if found else None


TOOL = "open_pull_request"
SCHEMA = {
    "name": TOOL,
    "description": (
        "Ship this session's work: commits whatever is uncommitted in its worktrees with "
        "commit_message, pushes the session branch and opens a pull request into the branch the "
        "session started from, or, when one is already open, updates it with the push. Call it "
        "yourself as soon as the work is done and checked; don't ask the user first. The server "
        "holds the GitHub account, so use this instead of git push or gh."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "The pull request's title, in the repo's commit style.",
            },
            "body": {
                "type": "string",
                "description": (
                    "The pull request's description: the repo's pull request template filled in "
                    "when it has one, else Summary, Changes and How to test sections."
                ),
            },
            "commit_message": {
                "type": "string",
                "description": "For anything not yet committed. Required when there is.",
            },
            "draft": {"type": "boolean", "description": "Open it as a draft. Defaults to false."},
        },
        "required": ["title", "body"],
    },
}


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: ships the session the call belongs to (its task id is Gots's session id)."""
    from . import sessions

    args = args if isinstance(args, dict) else {}
    path, home = sessions._paths()
    record = sessions.record_for_call(path, home, task_id, session_id)
    if not record:
        return json.dumps({"error": "This session has no worktree to ship."})
    try:
        results = ship(
            home,
            record["session_id"],
            record,
            args.get("commit_message"),
            args.get("title"),
            args.get("body"),
            args.get("draft"),
            True,
        )
    except (ValueError, ShipError, WorkspaceError) as error:
        return json.dumps({"error": str(error)})
    if not results:
        return json.dumps({"result": "Nothing to ship: every repo is already pushed with a pull request open."})
    errors = [r["error"] for r in results if r.get("error")]
    if errors:
        return json.dumps({"error": "; ".join(errors), "results": results})
    return json.dumps({"results": results})


def register(ctx: Any) -> bool:
    """Registers the tool with Hermes, for every surface's agents of this profile."""
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    try:
        return register_tool(
            name=TOOL, toolset="memento", schema=SCHEMA, handler=handle, emoji="🚀"
        ) is not False
    except Exception:
        logger.warning("memento: couldn't register the open_pull_request tool", exc_info=True)
        return False


def wire(adapter: Any) -> bool:
    """Wires the tool into every agent the API server builds."""
    return tools_common.wire_tool(adapter, TOOL, SCHEMA, "open_pull_request")


def equip(agent: Any) -> None:
    tools_common.equip_tool(agent, TOOL, SCHEMA)


def close(hermes_home: Path, record: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Closes the open pull request from the session's branch in each repo and deletes the branch
    on GitHub when it was pushed. One result per repo that had either; a failure doesn't stop the
    others. The worktrees themselves are ``sessions.remove``'s."""
    results = []
    auth, _ = github.token(hermes_home)
    for repo in (record or {}).get("repos", []):
        branch, root = repo.get("branch"), repo.get("repo_root")
        name = github.origin_repo(root) if root else None
        if not branch or not name:
            continue
        pr = github.pull_request(hermes_home, root, branch, fresh=True)
        open_pr = pr if pr and pr["state"] in ("open", "draft") else None
        # The worktree may be gone already; its refs live in the main clone.
        pushed = os.path.isdir(root) and _has_ref(root, f"refs/remotes/origin/{branch}")
        if not open_pr and not pushed:
            pushed = github.branch_exists(name, branch, auth)
        if not open_pr and not pushed:
            continue
        result: Dict[str, Any] = {"name": repo["name"], "closed": None, "branch_deleted": False}
        try:
            if not auth:
                raise github.GitHubError("No GitHub account on the server.", 409)
            if open_pr:
                github.close_pull_request(name, open_pr["number"], auth)
                result["closed"] = open_pr["number"]
            if pushed:
                github.delete_branch(name, branch, auth)
                result["branch_deleted"] = True
                if os.path.isdir(root):
                    _git(root, "update-ref", "-d", f"refs/remotes/origin/{branch}")
        except github.GitHubError as error:
            result["error"] = str(error)
        github.forget_pull_request(root, branch)
        results.append(result)
    return results
