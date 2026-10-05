"""GitHub for Memento's Code screen: the host's GitHub account, its repos, and cloning one into a
Hermes Project.

The token never leaves the Hermes host. It's found the way Hermes's own GitHub calls find it:
``GITHUB_TOKEN``, then ``GH_TOKEN`` (the process env, then ``$HERMES_HOME/.env``), then the gh CLI's
login (``gh auth token``).
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

API = "https://api.github.com"
TOKEN_ENV_VARS = ("GITHUB_TOKEN", "GH_TOKEN")
# owner/name as GitHub allows them; no dots-only names, so a repo can't name "." or "..".
REPO_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/(?!\.+$)[A-Za-z0-9._-]{1,100}$")
CLONE_TIMEOUT_S = 600
MAX_REPOS = 100


class GitHubError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _env_file_token(hermes_home: Path) -> Optional[str]:
    try:
        text = (hermes_home / ".env").read_text(encoding="utf-8")
    except OSError:
        return None
    values: Dict[str, str] = {}
    for line in text.splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if match:
            values[match.group(1)] = match.group(2).strip("'\"")
    return next((values[name] for name in TOKEN_ENV_VARS if values.get(name)), None)


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
    """The token and where it came from (``env`` or ``gh``), or ``(None, None)``."""
    for name in TOKEN_ENV_VARS:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value, "env"
    value = _env_file_token(hermes_home)
    if value:
        return value, "env"
    value = _gh_cli_token()
    return (value, "gh") if value else (None, None)


def _get(path: str, auth: str) -> Any:
    request = urllib.request.Request(
        f"{API}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {auth}",
            "User-Agent": "memento-hermes-plugin",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise GitHubError("GitHub rejected the server's token.", 401) from None
        raise GitHubError(f"GitHub answered {error.code}.") from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise GitHubError("Couldn't reach GitHub from the server.") from None


def status(hermes_home: Path) -> Dict[str, Any]:
    auth, source = token(hermes_home)
    if not auth:
        return {"connected": False}
    try:
        user = _get("/user", auth)
    except GitHubError as error:
        return {"connected": False, "source": source, "error": str(error)}
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


def clone(hermes_home: Path, repo: Any, dest_raw: Any) -> str:
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
        basic = base64.b64encode(f"x-access-token:{auth}".encode()).decode()
        command += ["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {basic}"]
    command += ["clone", "--", f"https://github.com/{repo}.git", dest]
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=CLONE_TIMEOUT_S, env=env, stdin=subprocess.DEVNULL
        )
    except FileNotFoundError:
        raise GitHubError("git isn't installed on the server.", 501) from None
    except subprocess.TimeoutExpired:
        shutil.rmtree(dest, ignore_errors=True)
        raise GitHubError("The clone took too long.", 504) from None
    if result.returncode != 0:
        shutil.rmtree(dest, ignore_errors=True)
        stderr = result.stderr.strip()
        if "could not read Username" in stderr or "Authentication failed" in stderr:
            raise GitHubError(f"GitHub refused access to {repo}.", 403)
        lines = [line for line in stderr.splitlines() if line.strip()]
        message = lines[-1] if lines else "git clone failed."
        raise GitHubError(message.replace(auth, "***") if auth else message, 502)
    return dest
