"""GitHub for Gots's Code screen: the host's GitHub account, its repos, and cloning one into a
Hermes Project.

The token never leaves the Hermes host. It's resolved through Hermes's own
``agent.credential_pool.get_env_prefer_dotenv()`` (``GITHUB_TOKEN``, then ``GH_TOKEN``), falling back
to the gh CLI's login (``gh auth token``).
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

API = "https://api.github.com"
TOKEN_ENV_VARS = ("GITHUB_TOKEN", "GH_TOKEN")
# owner/name as GitHub allows them; no dots-only names, so a repo can't name "." or "..".
REPO_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/(?!\.+$)[A-Za-z0-9._-]{1,100}$")
CLONE_TIMEOUT_S = 600
MAX_REPOS = 100
ORIGIN_RE = re.compile(r"github\.com[:/]([A-Za-z0-9-]+/[A-Za-z0-9._-]+?)(?:\.git)?/?$")
PR_CACHE_S = 30
# Checks still running are read again this often, so the app's pill is current while they do.
PR_PENDING_CACHE_S = 10
# A branch's pull requests, newest first as GitHub answers them; a session's history is short.
MAX_PRS = 100


def git_auth_args(auth: Optional[str]) -> list[str]:
    """``-c http…extraheader`` args for a ``git -c … fetch/clone/push`` command, or ``[]``."""
    if not auth:
        return []
    basic = base64.b64encode(f"x-access-token:{auth}".encode()).decode()
    return ["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {basic}"]


class GitHubError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _gh_cli_token() -> Optional[str]:
    if not shutil.which("gh"):
        return None
    try:
        result = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None if result.returncode == 0 else None


def token(hermes_home: Path) -> tuple[Optional[str], Optional[str]]:
    """The token and where it came from (``env`` or ``gh``), or ``(None, None)``.

    Reads through ``agent.credential_pool.get_env_prefer_dotenv`` (profile-scoped,
    never ``os.environ`` directly).  Background threads — project clones, pushes,
    webhook callbacks — don't inherit the caller's ``ContextVar`` secret scope,
    so when no scope is active we build one from ``hermes_home``.  Otherwise
    ``get_secret`` raises ``UnscopedSecretError`` under multiplexing and every
    clone fails.  See ``agent.secret_scope.UnscopedSecretError`` docstring.
    """
    from agent.credential_pool import get_env_prefer_dotenv

    _scope_reset = None
    try:
        from agent.secret_scope import (
            build_profile_secret_scope,
            set_secret_scope,
            reset_secret_scope,
            current_secret_scope,
        )
        if current_secret_scope() is None:
            _scope = build_profile_secret_scope(Path(hermes_home))
            _scope_reset = set_secret_scope(_scope, profile_home=str(hermes_home))
    except ImportError:
        # agent.secret_scope not available (tests, older Hermes) — skip scope setup
        pass

    try:
        for name in TOKEN_ENV_VARS:
            value = get_env_prefer_dotenv(name).strip()
            if value:
                return value, "env"
    finally:
        if _scope_reset is not None:
            reset_secret_scope(_scope_reset)

    value = _gh_cli_token()
    return (value, "gh") if value else (None, None)

def _request(path: str, auth: Optional[str], method: str = "GET", data: Optional[Dict[str, Any]] = None) -> Any:
    # Without a token, public repos still answer (rate-limited).
    request = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={
            "Accept": "application/vnd.github+json",
            **({"Authorization": f"Bearer {auth}"} if auth else {}),
            **({"Content-Type": "application/json"} if data is not None else {}),
            "User-Agent": "memento-hermes-plugin",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read()
            # A DELETE answers 204 with no body.
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise GitHubError("GitHub rejected the server's token.", 401) from None
        raise GitHubError(_error_message(error) or f"GitHub answered {error.code}.") from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise GitHubError("Couldn't reach GitHub from the server.") from None


def _error_message(error: urllib.error.HTTPError) -> Optional[str]:
    """What GitHub said was wrong (a 422's first error, e.g. "No commits between main and ...")."""
    try:
        body = json.load(error)
    except (ValueError, OSError):
        return None
    if not isinstance(body, dict):
        return None
    errors = body.get("errors")
    first = errors[0] if isinstance(errors, list) and errors else None
    detail = first.get("message") if isinstance(first, dict) else None
    message = detail if isinstance(detail, str) and detail else body.get("message")
    return message if isinstance(message, str) and message else None


def _get(path: str, auth: Optional[str]) -> Any:
    return _request(path, auth)


def status(hermes_home: Path) -> Dict[str, Any]:
    auth, source = token(hermes_home)
    if not auth:
        return {"connected": False, "source": source, "login": None}
    try:
        user = _get("/user", auth)
    except GitHubError as error:
        return {"connected": False, "source": source, "login": None, "error": str(error)}
    return {"connected": True, "source": source, "login": user.get("login")}


def repos(hermes_home: Path) -> List[Dict[str, Any]]:
    auth, _ = token(hermes_home)
    if not auth:
        raise GitHubError("No GitHub account on the server.", 409)
    rows = _get(
        f"/user/repos?sort=pushed&per_page={MAX_REPOS}&affiliation=owner,collaborator,organization_member",
        auth,
    )
    return [
        {
            "full_name": repo.get("full_name"),
            "description": repo.get("description"),
            "private": bool(repo.get("private")),
            "pushed_at": repo.get("pushed_at"),
        }
        for repo in rows
        if isinstance(repo, dict) and isinstance(repo.get("full_name"), str)
    ]


def _destination(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise GitHubError("Pick a folder to clone into.", 400)
    dest = os.path.abspath(os.path.expanduser(raw.strip()))
    if os.path.exists(dest) and (not os.path.isdir(dest) or os.listdir(dest)):
        raise GitHubError(f"{dest} already exists and isn't empty.", 409)
    return dest


class Cancelled(Exception):
    """A clone was stopped because its project was removed."""


def _run_git(command: List[str], env: Dict[str, str], cancel: Optional[threading.Event]):
    """``git`` that a ``cancel`` event can stop, in 1s slices, within ``CLONE_TIMEOUT_S``."""
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + CLONE_TIMEOUT_S
    while True:
        try:
            stdout, stderr = process.communicate(timeout=1)
            return process.returncode, stdout, stderr
        except subprocess.TimeoutExpired:
            stopped = cancel is not None and cancel.is_set()
            if stopped or time.monotonic() >= deadline:
                process.kill()
                process.communicate()
                if stopped:
                    raise Cancelled() from None
                raise


def clone(hermes_home: Path, repo: Any, dest_raw: Any, cancel: Optional[threading.Event] = None) -> str:
    """Clones ``owner/name`` from GitHub into ``dest`` and returns its absolute path."""
    if not isinstance(repo, str) or not REPO_RE.match(repo):
        raise GitHubError("repo must be owner/name.", 400)
    dest = _destination(dest_raw)
    auth, _ = token(hermes_home)
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    command = ["git"]
    if auth:
        # A header rather than a token in the URL, so it isn't saved in .git/config. Later fetches and
        # pushes use the host's own git credentials, like any other checkout there.
        command += git_auth_args(auth)
    command += ["clone", "--", f"https://github.com/{repo}.git", dest]
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        returncode, _, stderr = _run_git(command, env, cancel)
    except FileNotFoundError:
        raise GitHubError("git isn't installed on the server.", 501) from None
    except subprocess.TimeoutExpired:
        shutil.rmtree(dest, ignore_errors=True)
        raise GitHubError("The clone took too long.", 504) from None
    except Cancelled:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    if returncode != 0:
        shutil.rmtree(dest, ignore_errors=True)
        stderr = stderr.strip()
        if "could not read Username" in stderr or "Authentication failed" in stderr:
            raise GitHubError(f"GitHub refused access to {repo}.", 403)
        lines = [line for line in stderr.splitlines() if line.strip()]
        message = lines[-1] if lines else "git clone failed."
        raise GitHubError(message.replace(auth, "***") if auth else message, 502)
    return dest


def origin_repo(repo_root: str) -> Optional[str]:
    """``owner/name`` of the checkout's ``origin`` when it's on GitHub."""
    try:
        result = subprocess.run(
            ["git", "-C", repo_root, "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=5,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = result.returncode == 0 and ORIGIN_RE.search(result.stdout.strip())
    return match.group(1) if match else None


_pr_cache: Dict[Tuple[str, str, Optional[int]], Tuple[float, List[Dict[str, Any]]]] = {}


FAILED_CONCLUSIONS = {"failure", "timed_out", "cancelled", "action_required", "startup_failure"}


def _checks(repo: str, sha: str, auth: Optional[str]) -> Optional[str]:
    """``success``, ``failure`` or ``pending`` over the commit's check runs and statuses, else None."""
    outcomes = []
    try:
        runs = _get(f"/repos/{repo}/commits/{sha}/check-runs?per_page=100", auth).get("check_runs")
        for run in runs if isinstance(runs, list) else []:
            if not isinstance(run, dict):
                continue
            if run.get("status") != "completed":
                outcomes.append("pending")
            elif run.get("conclusion") in FAILED_CONCLUSIONS:
                outcomes.append("failure")
            else:
                outcomes.append("success")
    except GitHubError:
        pass
    try:
        # Legacy commit statuses (older CI integrations); "pending" there also means none yet.
        combined = _get(f"/repos/{repo}/commits/{sha}/status", auth)
        if combined.get("total_count"):
            state = combined.get("state")
            outcomes.append("failure" if state in ("failure", "error") else "pending" if state == "pending" else "success")
    except GitHubError:
        pass
    if not outcomes:
        return None
    if "failure" in outcomes:
        return "failure"
    return "pending" if "pending" in outcomes else "success"


def _state(row: Any) -> str:
    """A pulls-list row's state, the way the app reads it: merged, draft, closed or open."""
    if row.get("merged_at"):
        return "merged"
    if row.get("draft"):
        return "draft"
    return "closed" if row.get("state") == "closed" else "open"


def _pr(repo: str, row: Any, auth: Optional[str], checks: bool = True) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict) or not isinstance(row.get("number"), int):
        return None
    sha = (row.get("head") or {}).get("sha") if isinstance(row.get("head"), dict) else None
    return {
        "repo": repo,
        "number": row["number"],
        "title": row.get("title") if isinstance(row.get("title"), str) else "",
        "url": row.get("html_url") if isinstance(row.get("html_url"), str) else None,
        "state": _state(row),
        "checks": _checks(repo, sha, auth) if checks and isinstance(sha, str) and sha else None,
    }


def _cache_ttl(value: List[Dict[str, Any]]) -> float:
    """How long a cached answer is good for: shorter while any of its checks is still running."""
    return PR_PENDING_CACHE_S if any(pr.get("checks") == "pending" for pr in value) else PR_CACHE_S


def _live(row: Any) -> bool:
    """Whether a pull request's checks are worth asking after: it's open, a draft included.

    Reads the row's state through :func:`_state`, so liveness and the state the app is told are the
    same ladder read once — a draft is open on GitHub's row and a draft in the app either way.
    """
    return isinstance(row, dict) and _state(row) in ("open", "draft")


def pull_requests(
    hermes_home: Path,
    repo_root: str,
    branch: str,
    fresh: bool = False,
    checks: bool = True,
    strict: bool = False,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """The pull requests from ``branch`` of the checkout's GitHub repo, newest first.

    A branch keeps its pull requests on GitHub, the merged and closed ones included, so this is the
    session's whole history — what the app's outputs drawer lists. Only the live ones carry checks: a
    finished pull request's no longer matter, and each lookup is a request of its own.

    ``limit`` asks GitHub for only the newest few, for the caller that wants one (``pull_request``).
    The answer is cached under its own key, so a capped read can never serve the app's read of the
    session's whole history.

    Cached for a short while per branch: the app asks after every turn and on every catch-up. A
    cached answer serves a call without ``checks`` too; one without them isn't cached.

    ``strict`` lets the GitHub failure out instead of answering an empty list, so a caller that must
    tell "no pull requests" from "couldn't ask GitHub" — the app's read of a session's pull requests
    — never reads one as the other. Either way a failed lookup isn't cached: a failure isn't an
    answer.
    """
    key = (repo_root, branch, limit)
    cached = _pr_cache.get(key)
    if not fresh and cached and time.time() - cached[0] < _cache_ttl(cached[1]):
        return cached[1]
    value: List[Dict[str, Any]] = []
    failed = False
    repo = origin_repo(repo_root)
    if repo:
        head = urllib.parse.quote(f"{repo.split('/')[0]}:{branch}", safe=":")
        auth, _ = token(hermes_home)
        try:
            rows = _get(
                f"/repos/{repo}/pulls?head={head}&state=all&per_page={limit or MAX_PRS}", auth
            )
        except GitHubError:
            if strict:
                raise
            failed, rows = True, []
        if isinstance(rows, list):
            rows = rows[:limit] if limit else rows
            value = [
                pr
                for pr in (_pr(repo, row, auth, checks and _live(row)) for row in rows)
                if pr is not None
            ]
    if checks and not failed:
        _prune_cache()
        _pr_cache[key] = (time.time(), value)
    return value


def pull_request(
    hermes_home: Path,
    repo_root: str,
    branch: str,
    fresh: bool = False,
    checks: bool = True,
    strict: bool = False,
) -> Optional[Dict[str, Any]]:
    """The newest pull request from ``branch`` of the checkout's GitHub repo, with its checks, or None.

    The one ``pull_requests`` is asked for, capped and cached on its own: a branch's newest is the one
    its session is working on, which is all a check on its state needs.
    """
    found = pull_requests(
        hermes_home, repo_root, branch, fresh=fresh, checks=checks, strict=strict, limit=1
    )
    return found[0] if found else None


def _prune_cache() -> None:
    """Drops what's stale: a host keeps an entry per session it has ever opened a branch for."""
    stale = time.time() - PR_CACHE_S * 4
    for key in [key for key, (at, _) in _pr_cache.items() if at < stale]:
        del _pr_cache[key]


def forget_pull_request(repo_root: str, branch: str) -> None:
    """Forgets a branch's answers, the capped one ``pull_request`` keeps included."""
    for key in [key for key in _pr_cache if key[:2] == (repo_root, branch)]:
        del _pr_cache[key]


def create_pull_request(
    repo: str, branch: str, base: str, title: str, body: str, draft: bool, auth: str
) -> Dict[str, Any]:
    """Opens a pull request from ``branch`` into ``base`` of ``repo`` (``owner/name``)."""
    row = _request(
        f"/repos/{repo}/pulls",
        auth,
        "POST",
        {"title": title, "head": branch, "base": base, "body": body, "draft": draft},
    )
    # Brand new: its checks haven't started.
    found = _pr(repo, row, None, checks=False)
    if not found:
        raise GitHubError("GitHub didn't return the pull request.")
    return found


def close_pull_request(repo: str, number: int, auth: str) -> None:
    _request(f"/repos/{repo}/pulls/{number}", auth, "PATCH", {"state": "closed"})


def _ref(branch: str) -> str:
    return urllib.parse.quote(f"heads/{branch}", safe="/")


def delete_branch(repo: str, branch: str, auth: str) -> None:
    """Deletes the branch on GitHub; one that's already gone counts as deleted."""
    try:
        _request(f"/repos/{repo}/git/refs/{_ref(branch)}", auth, "DELETE")
    except GitHubError as error:
        if "Reference does not exist" not in str(error) and "Not Found" not in str(error):
            raise


def branch_exists(repo: str, branch: str, auth: Optional[str]) -> bool:
    try:
        return bool(_get(f"/repos/{repo}/git/ref/{_ref(branch)}", auth))
    except GitHubError:
        return False
