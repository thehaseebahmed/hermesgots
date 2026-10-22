"""Shipping a project session's work: the agent's ``pull_request`` tool commits what's left in
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

from . import github, pipeline, projects, push, tools_common
from .sessions import PR_FOOTER, WorkspaceError, _git
from .store import db_path

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


def _ref_sha(tree: str, ref: str) -> Optional[str]:
    """The commit a local reference points at, or ``None`` when it has none."""
    found = _git(tree, "rev-parse", "--verify", "-q", ref)
    return found.stdout.strip() or None if found.returncode == 0 else None


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


def _push(hermes_home: Path, tree: str, branch: str, force: bool = False) -> None:
    auth, _ = github.token(hermes_home)
    command = github.git_auth_args(auth)
    lease: List[str] = []
    if force:
        # --force-with-lease refuses a branch that moved since this tree last looked at it: git
        # compares the branch on GitHub against the commit we hand it, so that commit has to be one
        # we knew before now. Refreshing it first would always match and leave the guard a no-op.
        seen = _ref_sha(tree, f"refs/remotes/origin/{branch}")
        if not seen and _remote_sha(tree, command, branch):
            raise ShipError(
                "GitHub's branch has commits this tree has never fetched, so a force push would "
                "replace them blind. Fetch the branch first (git fetch origin), then call "
                "pull_request again.",
                409,
            )
        if seen:
            lease = [f"--force-with-lease=refs/heads/{branch}:{seen}"]
    pushed = _run(tree, [*command, "push", *lease, "-u", "origin", f"HEAD:refs/heads/{branch}"])
    if pushed.returncode != 0:
        stderr = pushed.stderr
        if "stale info" in stderr:
            raise ShipError(
                "GitHub's branch moved since this session last pushed or fetched it, so the force "
                "push was refused. Check what changed on the branch before forcing again.",
                409,
            )
        if "non-fast-forward" in stderr or "fetch first" in stderr:
            raise ShipError(
                "GitHub's branch has commits this one doesn't (it was rewritten or moved). "
                "Call pull_request again with force: true to replace them.",
                409,
            )
        raise _push_error(stderr, "git push failed.", auth)


def _remote_sha(tree: str, command: List[str], branch: str) -> Optional[str]:
    """The commit ``branch`` is at on ``origin``, asked of the remote itself: ``None`` when it has
    none (a branch this session hasn't pushed yet, or a remote we couldn't reach)."""
    found = _run(tree, [*command, "ls-remote", "origin", f"refs/heads/{branch}"])
    line = found.stdout.strip() if found.returncode == 0 else ""
    return line.split("\t", 1)[0] if line else None


def _push_error(stderr: str, fallback: str, auth: Optional[str]) -> ShipError:
    if "could not read Username" in stderr or "Authentication failed" in stderr or "403" in stderr:
        return ShipError("GitHub refused the push. Check the server's GitHub account.", 403)
    return ShipError(_last_line(stderr, fallback, auth))


def _body(
    tree: str,
    base: Optional[str],
    body: Optional[str],
    reference: Optional[str] = None,
) -> str:
    if not body:
        log = _git(tree, "log", "--reverse", "--format=- %s", f"origin/{base}..HEAD") if base else None
        body = log.stdout.strip() if log is not None and log.returncode == 0 else ""
    body = _with_reference(body, reference)
    if PR_FOOTER in body:
        return body
    return f"{body}\n\n{PR_FOOTER}" if body else PR_FOOTER


def _with_reference(body: str, reference: Optional[str]) -> str:
    if not reference or any(line.strip() == reference for line in body.splitlines()):
        return body
    if PR_FOOTER in body:
        return body.replace(PR_FOOTER, f"{reference}\n\n{PR_FOOTER}", 1)
    return f"{body}\n\n{reference}" if body.strip() else reference


def _closes(task: Optional[Dict[str, Any]], repo_name: Optional[str]) -> Optional[str]:
    """The line that closes an AFK session's task, only in the repository the task lives in.

    GitHub closes an issue through a pull request in the same repository, and a cross-repository
    ``Closes owner/repo#n`` doesn't close anything — so a project that spans repositories gets the
    reference once, on the pull request that can act on it (ADR 0012).
    """
    if not task or not repo_name:
        return None
    repo, number = task.get("repo"), task.get("number")
    if not isinstance(repo, str) or repo.lower() != repo_name.lower():
        return None
    return f"Closes #{number}" if isinstance(number, int) else None


def _open_pr(
    hermes_home: Path,
    repo: Dict[str, Any],
    state: Dict[str, Any],
    title: Optional[str],
    body: Optional[str],
    session_id: Optional[str] = None,
    task: Optional[Dict[str, Any]] = None,
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
    reference = _closes(task, name)
    try:
        created = github.create_pull_request(
            name,
            repo["branch"],
            state["base"],
            title[:MAX_TITLE],
            _body(tree, state["base"], body, reference),
            True,
            auth,
        )
    except github.GitHubError as error:
        raise ShipError(str(error), error.status) from None
    github.forget_pull_request(repo["repo_root"], repo["branch"])
    if session_id and reference:
        push.notify("afk_pr", session_id, db_path(hermes_home))
    return created


def _lock(session_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(session_id, threading.Lock())


def ship(
    hermes_home: Path,
    session_id: str,
    record: Dict[str, Any],
    message: Optional[str],
    title: Optional[str],
    body: Optional[str],
    open_pr: bool,
    force: bool,
) -> List[Dict[str, Any]]:
    """Commits each worktree's changes with ``message``, pushes its branch and, with ``open_pr``,
    opens a draft pull request where the branch has none open. ``force`` replaces the branch's
    remote commits (after a rebase or amend). One result per repo that had work; a repo's failure
    doesn't stop the others."""
    message = _text(message, "message", MAX_MESSAGE)
    title = _text(title, "title", MAX_TITLE)
    body = _text(body, "body", MAX_BODY)
    lock = _lock(session_id)
    if not lock.acquire(blocking=False):
        raise ShipError("This session's changes are already being pushed.", 409)
    try:
        states = {state["name"]: state for state in status(record)}
        if not message and any(state["changed"] for state in states.values()):
            raise ValueError("A commit message is required.")
        task = record.get("task")
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
            wants_pr = open_pr and not live_pr and (new_work or (not existing and state["ahead"]))
            if not (state["changed"] or state["unpushed"] or wants_pr or force):
                continue
            result: Dict[str, Any] = {"name": repo["name"], "committed": None, "pushed": False, "pr": live_pr}
            try:
                if state["changed"]:
                    result["committed"] = _commit(hermes_home, repo["path"], message)
                    state = _repo_status(repo) or state
                if state["unpushed"] or not state["pushed"] or force:
                    _push(hermes_home, repo["path"], repo["branch"], force)
                    result["pushed"] = True
                if wants_pr:
                    result["pr"] = _open_pr(
                        hermes_home, repo, state, title, body, session_id, task
                    )
            except (ShipError, WorkspaceError) as error:
                result["error"] = str(error)
            results.append(result)
        return results
    finally:
        lock.release()


def update(
    hermes_home: Path, record: Dict[str, Any], title: Optional[str], body: Optional[str]
) -> List[Dict[str, Any]]:
    """Changes the title and/or body of each repo's open pull request on the session's branch."""
    title = _text(title, "title", MAX_TITLE)
    body = _text(body, "body", MAX_BODY)
    if not title and not body:
        raise ValueError("update needs a title or a body to change.")
    auth, _ = github.token(hermes_home)
    if not auth:
        raise ShipError("No GitHub account on the server.", 409)
    task = record.get("task")
    results = []
    for repo in record["repos"]:
        name = github.origin_repo(repo["repo_root"])
        if not name:
            continue
        pr = github.pull_request(hermes_home, repo["repo_root"], repo["branch"], fresh=True, checks=False)
        if not pr or pr["state"] not in ("open", "draft"):
            continue
        result: Dict[str, Any] = {"name": repo["name"], "pr": pr}
        try:
            reference = _closes(task, name)
            result["pr"] = github.update_pull_request(
                name,
                pr["number"],
                title,
                _with_reference(body, reference) if body else body,
                auth,
            )
            github.forget_pull_request(repo["repo_root"], repo["branch"])
        except github.GitHubError as error:
            result["error"] = str(error)
        results.append(result)
    if not results:
        raise ShipError("No open pull request on this session's branch to update.", 409)
    return results


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


TOOL = "pull_request"
LEGACY_TOOL = "open_pull_request"
ACTIONS = ("ship", "push", "update", "status")
# Listed so the agent gets the teaching refusal rather than a schema error; never performed here.
REFUSED_ACTIONS = ("merge", "close")
SCHEMA = {
    "name": TOOL,
    "description": (
        "Ships this session's work to its pull request. action: 'ship' commits what's uncommitted in "
        "its worktrees with commit_message, pushes the session branch and opens a pull request (always "
        "a draft) or pushes to the one already open; 'push' commits and pushes without opening one; "
        "'update' changes the open pull request's title and/or body; 'status' reports changes and "
        "unpushed commits without writing anything. Pass force: true only after a rebase or amend, to "
        "replace the branch's remote commits. Call 'ship' yourself as soon as the work is done and "
        "checked; don't ask the user first. Merging and closing are the user's decision: the tool "
        "refuses them, so ask the user with clarify instead. The server holds the GitHub account, so use "
        "this instead of git push or gh."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [*ACTIONS, *REFUSED_ACTIONS],
                "description": "What to do: ship, push, update or status. Required.",
            },
            "title": {
                "type": "string",
                "description": "The pull request's title, in the repo's commit style (ship, update).",
            },
            "body": {
                "type": "string",
                "description": (
                    "The pull request's description: the repo's pull request template filled in "
                    "when it has one, else Summary, Changes and How to test sections (ship, update)."
                ),
            },
            "commit_message": {
                "type": "string",
                "description": "For anything not yet committed. Required when there is (ship, push).",
            },
            "force": {
                "type": "boolean",
                "description": (
                    "Replace the branch's remote commits with this one's, after a rebase or amend "
                    "(ship, push). Off by default. Refused when the branch has moved since this "
                    "session last pushed or fetched it, rather than overwriting that work."
                ),
            },
        },
        "required": ["action"],
    },
}
LEGACY_SCHEMA = {
    "name": LEGACY_TOOL,
    "description": "Retired: call pull_request with action 'ship' instead. This only returns that redirect.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}


def _staged_refusal(record: Dict[str, Any]) -> str:
    """Why a run that isn't its workflow's shipping stage can't open the pull request.

    Every other stage is named — the ones before the shipping stage and the ones after it — because
    the rule is the workflow's, not the three stages AFK used to have: a build ends at the gate the
    host runs, and a wrap-up runs when the draft is already open (ADR 0020).
    """
    name = pipeline.stage_name(record)
    ship = pipeline.shipping_name(record) or ""
    if name is None:
        return (
            "This task's workflow has finished, and its work is in the pull request it opened. "
            "Don't call pull_request with 'ship' again."
        )
    if pipeline.kind(record) == pipeline.DONE:
        return (
            f'This session is in its "{name}" stage of a staged task, which runs after the stage '
            f'that ships: "{ship}" has already opened the pull request, so there is nothing left '
            f"for this stage to open. Change nothing and end this run, and don't call pull_request "
            f"with 'ship' again."
        )
    gate = (
        " Call afk_gate with the commands the work is checked by, then end this run."
        if pipeline.gating(record)
        else " End this run."
    )
    return (
        f'This session is in its "{name}" stage of a staged task, so it can\'t ship: "{ship}" is '
        f"the stage that opens the pull request.{gate} Don't call pull_request with 'ship' again."
    )


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: ships the session the call belongs to (its task id is Gots's session id)."""
    from . import sessions

    args = args if isinstance(args, dict) else {}
    action = args.get("action")
    if action in REFUSED_ACTIONS:
        return json.dumps(
            {
                "error": (
                    f"Don't {action} pull requests yourself: merging and closing are the user's decision, "
                    "and this tool won't do either. Don't call pull_request with "
                    f"'{action}' again. Ask the user with the clarify tool whether they want to {action} "
                    "the pull request, and leave it to them."
                )
            }
        )
    if action not in ACTIONS:
        return json.dumps({"error": "action is required: ship, push, update or status."})
    force = args.get("force")
    if force is not None and not isinstance(force, bool):
        return json.dumps({"error": "force must be true or false."})
    path, home = sessions._paths()
    record = sessions.record_for_call(path, home, task_id, session_id)
    if not record:
        return json.dumps({"error": "This session has no worktree to ship."})
    if action == "ship":
        staged = pipeline.read(record.get("pipeline"))
        if staged is not None and not pipeline.ships(staged):
            return json.dumps({"error": _staged_refusal(staged)})
    try:
        if action == "status":
            return json.dumps({"results": status(record)})
        if action == "update":
            results = update(home, record, args.get("title"), args.get("body"))
        else:
            results = ship(
                home,
                record["session_id"],
                record,
                args.get("commit_message"),
                args.get("title"),
                args.get("body"),
                open_pr=action == "ship",
                force=bool(force),
            )
    except (ValueError, ShipError, WorkspaceError) as error:
        return json.dumps({"error": str(error)})
    if not results:
        return json.dumps({"result": "Nothing to ship: every repo is already pushed with a pull request open."})
    errors = [r["error"] for r in results if r.get("error")]
    if errors:
        return json.dumps({"error": "; ".join(errors), "results": results})
    return json.dumps({"results": results})


def handle_legacy(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    return json.dumps({"error": "open_pull_request was renamed: call pull_request with action 'ship' (it always opens a draft)."})


def register(ctx: Any) -> bool:
    """Registers the tools with Hermes, for every surface's agents of this profile."""
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    try:
        current = register_tool(name=TOOL, toolset="gots", schema=SCHEMA, handler=handle, emoji="🚀") is not False
        legacy = register_tool(
            name=LEGACY_TOOL, toolset="gots", schema=LEGACY_SCHEMA, handler=handle_legacy, emoji="🚀"
        ) is not False
        if not legacy:
            logger.warning("gots: couldn't register the open_pull_request redirect stub")
        return current
    except Exception:
        logger.warning("gots: couldn't register the pull_request tools", exc_info=True)
        return False


def wire(adapter: Any) -> bool:
    """Wires the tools into every agent the API server builds."""
    current = tools_common.wire_tool(adapter, TOOL, SCHEMA, "pull_request")
    if not tools_common.wire_tool(adapter, LEGACY_TOOL, LEGACY_SCHEMA, "open_pull_request"):
        logger.warning("gots: couldn't wire the open_pull_request redirect stub")
    return current


def equip(agent: Any) -> None:
    tools_common.equip_tool(agent, TOOL, SCHEMA)
    tools_common.equip_tool(agent, LEGACY_TOOL, LEGACY_SCHEMA)


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
