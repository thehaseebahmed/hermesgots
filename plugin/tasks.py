"""The frontier rule, and the read that feeds it from GitHub.

The rule is one function over task rows the plugin has already fetched, so it can be tested with
fabricated rows and no GitHub: a task is ready when it is open, marked ready for an agent, every
blocker is closed, and it carries neither an assignee nor Gots's claim mark. The read below turns
GitHub's issues into those rows — each repository's open issues carrying the ready mark, and the
blockers of the ones that have any — and nothing in it decides what the frontier is.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import github
from .repos import _repo_of

READY_LABEL = "ready-for-agent"
CLAIM_LABEL = "gots-got-it"
# GitHub answers a list a page at a time and this is the largest page it offers; the read follows
# every page it is offered, so a repository's newest ready tasks aren't lost behind its oldest.
PAGE_SIZE = 100
# A cap on how far that following goes, not a limit on what a project has: it is here so a `Link`
# header that points back at a page already read can't keep the read going. Fifty pages is more
# ready tasks than one repository has open at once in practice.
MAX_PAGES = 50
BLOCKED_BY_RE = re.compile(r"^\s*(?:[-*]\s*)?blocked\s+by:?\s*(.+)$", re.IGNORECASE | re.MULTILINE)
NUMBER_RE = re.compile(r"#(\d+)")
REPOSITORY_URL_RE = re.compile(r"/repos/([^/]+/[^/]+)$")
LINK_NEXT_RE = re.compile(r'<([^>]+)>\s*;\s*rel="next"')


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


# What a task row keeps once the rule has decided where it goes. The frontier is the ready group
# (GLOSSARY.md); the other two are the tasks that are out of it, with why.
SHOWN = ("repo", "number", "title", "url", "created_at", "assignees", "blockers")


def issue_url(task: Dict[str, Any]) -> str:
    url = task.get("url")
    if url:
        return str(url)
    repo = task.get("repo")
    return f"https://github.com/{repo}/issues/{task.get('number')}" if repo else ""


def groups(tasks: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """The project's tasks grouped the way AFK reads them: ready, claimed and blocked.

    Only an open task carrying the ready mark is one of AFK's at all; it's out of the frontier when
    it carries Gots's claim mark or an assignee — someone has it — and blocked while any of its
    blockers is still open, those named on the row. What's left is the frontier, oldest first.
    """
    ready: List[Dict[str, Any]] = []
    claimed: List[Dict[str, Any]] = []
    blocked: List[Dict[str, Any]] = []
    for task in sorted(tasks, key=order):
        if task.get("state") != "open":
            continue
        labels = task.get("labels") or []
        if READY_LABEL not in labels:
            continue
        row = {key: task.get(key) for key in SHOWN}
        row["title"] = row["title"] or ""
        row["assignees"] = list(row["assignees"] or [])
        if _claimed(labels, row["assignees"]):
            row["blockers"] = []
            claimed.append(row)
            continue
        row["blockers"] = [
            blocker for blocker in task.get("blockers") or [] if blocker.get("state") != "closed"
        ]
        (blocked if row["blockers"] else ready).append(row)
    return {"ready": ready, "claimed": claimed, "blocked": blocked}


def _body(text: Any) -> str:
    """An issue's body as the run reads it: GitHub's web editor saves CRLF, the run's text is LF."""
    return text.replace("\r\n", "\n").replace("\r", "\n") if isinstance(text, str) else ""


def _claimed(labels: Iterable[Any], assignees: Iterable[Any]) -> bool:
    """Whether someone has the task: Gots's own mark, or an assignee who took it."""
    return CLAIM_LABEL in labels or bool(list(assignees))


def order(task: Dict[str, Any]) -> Tuple[str, int]:
    """Oldest first: GitHub's own creation time, with the issue number breaking a tie.

    The one rule every task list is ordered by — the sheet's groups, and the order a pass claims
    in — so a task sorts where it sorts however it is asked about.
    """
    created = task.get("created_at")
    number = task.get("number")
    return (created if isinstance(created, str) else "", number if isinstance(number, int) else 0)


def empty() -> Dict[str, Any]:
    """A project with no repository to read: the route's answer while it clones, and the read's."""
    return {"repos": [], "ready": [], "claimed": [], "blocked": []}


def read(hermes_home: Path, folders: Iterable[Any]) -> Dict[str, Any]:
    """The project's tasks as GitHub holds them, grouped by `groups`.

    Each repository the project's checkouts point at is asked for its open ready tasks — a request
    per page GitHub offers, since only those can be in the frontier — and each candidate's blockers
    after that: only the ones GitHub says are open, and never a claimed task's, so a task with none
    costs nothing. A project with no GitHub repository has no tasks to read, and no request goes
    out.
    """
    repos, found = _gather(hermes_home, folders)
    return {"repos": repos, **groups(found)} if repos else empty()


def frontier(hermes_home: Path, folders: Iterable[Any]) -> List[Dict[str, Any]]:
    """Every task in the frontier with its issue's body, oldest first.

    The sweep's read rather than the sheet's: a pass filling several places takes all of them from
    one read of GitHub rather than reading the repository again for each. The bodies come off the
    same read, so each task claimed opens its run with the text it was judged by, while the rows
    nothing claims are dropped by the caller and their bodies never copied into an answer.
    """
    _, found = _gather(hermes_home, folders)
    bodies = {(row["repo"], row["number"]): row.get("body") or "" for row in found}
    return [
        {**row, "body": bodies.get((row["repo"], row["number"]), "")}
        for row in groups(found)["ready"]
    ]


def next_ready(hermes_home: Path, folders: Iterable[Any]) -> Optional[Dict[str, Any]]:
    """The oldest task in the frontier with its issue's body, or None when there is none."""
    ready = frontier(hermes_home, folders)
    return ready[0] if ready else None


def _gather(hermes_home: Path, folders: Iterable[Any]) -> Tuple[List[str], List[Dict[str, Any]]]:
    """Every candidate task the project's repositories hold, with its blockers, and the repos read."""
    repos = repos_of(folders)
    if not repos:
        return [], []
    auth, _ = github.token(hermes_home)
    if not auth:
        raise github.GitHubError("No GitHub account on the server.", 409)
    edges: Dict[Tuple[str, int], List[Dict[str, Any]]] = {}
    looked_up: Dict[Tuple[str, int], Optional[Dict[str, Any]]] = {}
    found: List[Dict[str, Any]] = []
    for repo in repos:
        for row in _candidates(repo, auth):
            if isinstance(row, dict) and not row.get("pull_request"):
                found.append(_task(repo, row, auth, edges, looked_up))
    return repos, found


def repos_of(folders: Iterable[Any]) -> List[str]:
    """Each GitHub repository a checkout of the project's points at, once, in the project's order."""
    repos: List[str] = []
    for folder in folders:
        path = getattr(folder, "path", None)
        repo = _repo_of(path) if isinstance(path, str) else None
        if repo and repo not in repos:
            repos.append(repo)
    return repos


def next_page(link: Any) -> Optional[str]:
    """The path a `Link` header's next page names, as this module's requests take one, or nothing.

    GitHub answers an absolute ``https://api.github.com/…`` URL; every request here is built from a
    path, so the API's own prefix comes off, and a header naming any other host is ignored.
    """
    match = LINK_NEXT_RE.search(link) if isinstance(link, str) else None
    if not match or not match.group(1).startswith(github.API):
        return None
    return match.group(1)[len(github.API) :] or None


def _candidates(repo: str, auth: str) -> List[Any]:
    """A repository's open tasks: every open issue carrying the ready mark, oldest first.

    GitHub answers a list a page at a time, so the read follows its `Link` header rather than
    stopping at the first hundred: a repository with more ready tasks than that would otherwise
    lose its newest ones, which are the ones AFK has waited longest to reach. Pull requests come
    back from this endpoint too, and the caller drops them — a pull request is never a task.
    """
    rows: List[Any] = []
    path = (
        f"/repos/{repo}/issues?state=open&labels={READY_LABEL}"
        f"&sort=created&direction=asc&per_page={PAGE_SIZE}"
    )
    for _ in range(MAX_PAGES):
        page, link = github._page(path, auth)
        if isinstance(page, list):
            rows.extend(page)
        following = next_page(link)
        if not following or following == path:
            break
        path = following
    return rows


def _task(
    repo: str,
    row: Dict[str, Any],
    auth: str,
    edges: Dict[Tuple[str, int], List[Dict[str, Any]]],
    looked_up: Dict[Tuple[str, int], Optional[Dict[str, Any]]],
) -> Dict[str, Any]:
    """One issue as a task row: what the grouping rule reads, and nothing else."""
    labels = [
        label.get("name")
        for label in row.get("labels") or []
        if isinstance(label, dict) and isinstance(label.get("name"), str)
    ]
    assignees = [
        assignee.get("login")
        for assignee in row.get("assignees") or []
        if isinstance(assignee, dict) and isinstance(assignee.get("login"), str)
    ]
    # A claimed task is out of the frontier whatever it blocks, so its blockers aren't read.
    blockers = [] if _claimed(labels, assignees) else _blockers(repo, row, auth, edges, looked_up)
    return {
        "repo": repo,
        "number": row.get("number"),
        "title": row.get("title") or "",
        "url": row.get("html_url"),
        "body": _body(row.get("body")),
        "state": row.get("state") or "open",
        "created_at": row.get("created_at"),
        "labels": labels,
        "assignees": assignees,
        "blockers": blockers,
    }


def _blockers(
    repo: str,
    row: Dict[str, Any],
    auth: str,
    edges: Dict[Tuple[str, int], List[Dict[str, Any]]],
    looked_up: Dict[Tuple[str, int], Optional[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """The task's blockers: GitHub's native edges, else its body's `Blocked by:` line.

    The summary counts the issue's edges — `blocked_by` the ones still open, `total_blocked_by`
    every one it ever had — so a task with no open edge is asked nothing further, and only a task
    with no edges at all reads its body instead. A task *with* edges never falls back to the line,
    since the line is the older habit the edges replace.
    """
    summary = row.get("issue_dependencies_summary")
    if isinstance(summary, dict):
        # No edge at all: the body's line is what this issue was written with.
        if summary.get("total_blocked_by") == 0:
            return _from_body(repo, row, auth, looked_up)
        # Edges, but not one still open: every blocker it had is closed, so a request would only
        # confirm it.
        if summary.get("blocked_by") == 0:
            return []
        return _edges(repo, row.get("number"), auth, edges)
    # A payload without the summary says nothing about its edges, so they're read and the body's
    # line is the fallback when there are none.
    return _edges(repo, row.get("number"), auth, edges) or _from_body(repo, row, auth, looked_up)


def _edges(
    repo: str, number: Any, auth: str, cache: Dict[Tuple[str, int], List[Dict[str, Any]]]
) -> List[Dict[str, Any]]:
    """The issues blocking one, closed ones included, each once per read of the project."""
    key = (repo, number)
    if key not in cache:
        rows = github._get(f"/repos/{repo}/issues/{number}/dependencies/blocked_by", auth)
        cache[key] = (
            [_issue(row, repo) for row in rows if isinstance(row, dict)]
            if isinstance(rows, list)
            else []
        )
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
            # A blocker nobody could read counts as open (see below); one GitHub says isn't there
            # doesn't block anything.
            cache[key] = None if github.is_missing(error) else {"number": number, "state": "open"}
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
