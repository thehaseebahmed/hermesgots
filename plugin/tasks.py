"""The frontier rule, and the read that feeds it from GitHub.

The rule is one function over task rows the plugin has already fetched, so it can be tested with
fabricated rows and no GitHub: a task is ready when it is open, marked ready for an agent, every
blocker is closed, and it carries neither an assignee nor Gots's claim mark. The read below turns
GitHub's issues into those rows — each repository's open issues carrying the ready mark, and the
blockers of the ones that have any — and nothing in it decides what the frontier is.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import github

READY_LABEL = "ready-for-agent"
CLAIM_LABEL = "gots-got-it"
# A repository's ready tasks are read oldest first, which is the order AFK works them in, so the
# oldest page is the one that matters when a repository has more open tasks than this.
MAX_PER_REPO = 100
BLOCKED_BY_RE = re.compile(r"^\s*(?:[-*]\s*)?blocked\s+by:?\s*(.+)$", re.IGNORECASE | re.MULTILINE)
NUMBER_RE = re.compile(r"#(\d+)")
REPOSITORY_URL_RE = re.compile(r"/repos/([^/]+/[^/]+)$")


def parse_blocked_by(body: Any) -> List[int]:
    """The issue numbers a body's `Blocked by:` line names, in the order it writes them.

    The line is the fallback for a task whose issue carries no native dependency edge — the shape
    the tracker docs already use — so it's read from the start of a line and nowhere else: a body
    that mentions an issue in prose is not a blocker.
    """
    if not isinstance(body, str):
        return []
    found: List[int] = []
    for match in BLOCKED_BY_RE.finditer(body):
        for number in NUMBER_RE.findall(match.group(1)):
            if int(number) not in found:
                found.append(int(number))
    return found


def frontier(tasks: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """The project's tasks split the way AFK reads them: ready, claimed and blocked.

    Only an open task carrying the ready mark is one of AFK's at all; it's out of the frontier when
    it carries Gots's claim mark or an assignee — someone has it — and blocked while any of its
    blockers is still open, those named on the row. What's left is ready, oldest first.
    """
    ready: List[Dict[str, Any]] = []
    claimed: List[Dict[str, Any]] = []
    blocked: List[Dict[str, Any]] = []
    for task in sorted(tasks, key=_order):
        if task.get("state") != "open":
            continue
        labels = task.get("labels") or []
        if READY_LABEL not in labels:
            continue
        row = {
            "repo": task.get("repo"),
            "number": task.get("number"),
            "title": task.get("title") or "",
            "url": task.get("url"),
            "created_at": task.get("created_at"),
            "assignees": list(task.get("assignees") or []),
        }
        if CLAIM_LABEL in labels or row["assignees"]:
            claimed.append(row)
            continue
        open_blockers = [
            blocker for blocker in task.get("blockers") or [] if blocker.get("state") != "closed"
        ]
        if open_blockers:
            row["blockers"] = open_blockers
            blocked.append(row)
        else:
            ready.append(row)
    return {"ready": ready, "claimed": claimed, "blocked": blocked}


def _order(task: Dict[str, Any]) -> Tuple[str, int]:
    """Oldest first: GitHub's own creation time, with the issue number breaking a tie."""
    created = task.get("created_at")
    number = task.get("number")
    return (created if isinstance(created, str) else "", number if isinstance(number, int) else 0)


def read(hermes_home: Path, folders: Iterable[Any]) -> Dict[str, Any]:
    """The project's tasks as GitHub holds them, split by `frontier`.

    Each repository the project's checkouts point at is asked once for its open ready tasks — one
    request per repository, since only those can be in the frontier — and the blockers of each are
    read after that, so a task with none costs nothing. A project with no GitHub repository has no
    tasks to read, and no request goes out.
    """
    repos = _repos(folders)
    if not repos:
        return {"repos": [], "ready": [], "claimed": [], "blocked": []}
    auth, _ = github.token(hermes_home)
    if not auth:
        raise github.GitHubError("No GitHub account on the server.", 409)
    edges: Dict[Tuple[str, int], List[Dict[str, Any]]] = {}
    looked_up: Dict[Tuple[str, int], Optional[Dict[str, Any]]] = {}
    tasks: List[Dict[str, Any]] = []
    for repo in repos:
        for row in _candidates(repo, auth):
            if isinstance(row, dict) and not row.get("pull_request"):
                tasks.append(_task(repo, row, auth, edges, looked_up))
    return {"repos": repos, **frontier(tasks)}


def _repos(folders: Iterable[Any]) -> List[str]:
    """Each GitHub repository a checkout of the project's points at, once, in the project's order."""
    repos: List[str] = []
    for folder in folders:
        path = getattr(folder, "path", None)
        if not isinstance(path, str) or not os.path.exists(os.path.join(path, ".git")):
            continue
        repo = github.origin_repo(path)
        if repo and repo not in repos:
            repos.append(repo)
    return repos


def _candidates(repo: str, auth: str) -> List[Any]:
    """A repository's open tasks: the open issues carrying the ready mark, oldest first.

    GitHub's issues endpoint answers pull requests too, and those are dropped by the caller — a
    pull request is never a task.
    """
    rows = github._get(
        f"/repos/{repo}/issues?state=open&labels={READY_LABEL}"
        f"&sort=created&direction=asc&per_page={MAX_PER_REPO}",
        auth,
    )
    return rows if isinstance(rows, list) else []


def _task(
    repo: str,
    row: Dict[str, Any],
    auth: str,
    edges: Dict[Tuple[str, int], List[Dict[str, Any]]],
    looked_up: Dict[Tuple[str, int], Optional[Dict[str, Any]]],
) -> Dict[str, Any]:
    """One issue as a task row: what the frontier rule reads, and nothing else."""
    return {
        "repo": repo,
        "number": row.get("number"),
        "title": row.get("title") or "",
        "url": row.get("html_url"),
        "state": row.get("state") or "open",
        "created_at": row.get("created_at"),
        "labels": [
            label.get("name")
            for label in row.get("labels") or []
            if isinstance(label, dict) and isinstance(label.get("name"), str)
        ],
        "assignees": [
            assignee.get("login")
            for assignee in row.get("assignees") or []
            if isinstance(assignee, dict) and isinstance(assignee.get("login"), str)
        ],
        "blockers": _blockers(repo, row, auth, edges, looked_up),
    }


def _blockers(
    repo: str,
    row: Dict[str, Any],
    auth: str,
    edges: Dict[Tuple[str, int], List[Dict[str, Any]]],
    looked_up: Dict[Tuple[str, int], Optional[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """The task's blockers: GitHub's native edges, else its body's `Blocked by:` line.

    The summary says whether the issue has native edges at all — `total_blocked_by` counts them
    closed ones included — so a task without any reads its body instead. A task *with* edges never
    falls back to the line, since the line is the older habit the edges replace.
    """
    summary = row.get("issue_dependencies_summary")
    total = summary.get("total_blocked_by") if isinstance(summary, dict) else None
    if total is None or total:
        native = _edges(repo, row.get("number"), auth, edges)
        # No count to go by, and no edge to be found: this issue's blockers are its body's line.
        if native or total:
            return native
    return _from_body(repo, row, auth, looked_up)


def _edges(
    repo: str, number: Any, auth: str, cache: Dict[Tuple[str, int], List[Dict[str, Any]]]
) -> List[Dict[str, Any]]:
    """The issues blocking one, closed ones included, each once per read of the project."""
    key = (repo, number)
    if key not in cache:
        rows = github._get(f"/repos/{repo}/issues/{number}/dependencies/blocked_by", auth)
        cache[key] = [_issue(row, repo) for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    return cache[key]


def _from_body(
    repo: str,
    row: Dict[str, Any],
    auth: str,
    looked_up: Dict[Tuple[str, int], Optional[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Each issue a `Blocked by:` line names, read by number so a closed one is known to be closed."""
    found: List[Dict[str, Any]] = []
    for number in parse_blocked_by(row.get("body")):
        if number == row.get("number"):
            continue
        issue = _issue_at(repo, number, auth, looked_up)
        if issue is not None:
            found.append(issue)
    return found


def _issue_at(
    repo: str, number: int, auth: str, cache: Dict[Tuple[str, int], Optional[Dict[str, Any]]]
) -> Optional[Dict[str, Any]]:
    """One referenced issue, or None when GitHub says there is no such issue.

    A lookup that can't be answered at all counts as open: a blocker nobody could read is not one
    that's closed, and reading it as closed would let the task behind it be worked too early.
    """
    key = (repo, number)
    if key not in cache:
        try:
            cache[key] = github._get(f"/repos/{repo}/issues/{number}", auth)
        except github.GitHubError as error:
            not_found = error.status == 404 or str(error).startswith("Not Found")
            cache[key] = None if not_found else {"number": number, "state": "open"}
    row = cache[key]
    return _issue(row, repo) if isinstance(row, dict) else None


def _issue(row: Dict[str, Any], repo: str) -> Dict[str, Any]:
    """A blocker as the app shows it: where it lives, what it's called and whether it's closed."""
    url = row.get("repository_url")
    match = REPOSITORY_URL_RE.search(url) if isinstance(url, str) else None
    return {
        "repo": match.group(1) if match else repo,
        "number": row.get("number"),
        "title": row.get("title") or "",
        "url": row.get("html_url"),
        "state": row.get("state") or "open",
    }
