"""The frontier rule over fabricated task rows, and the read that feeds it from GitHub.

The rule itself never touches GitHub: these tasks are dictionaries shaped like the rows the read
builds, so what's asserted is what AFK offers. The read is exercised through the plugin's HTTP stub,
the way the pull request cache's is, with ``github.token`` and ``github.origin_repo`` patched.

Run: python3 -m unittest plugin.tests.test_tasks -v
"""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, Iterable, List, Optional
from unittest.mock import patch

from plugin import github, tasks
from plugin.tasks import CLAIM_LABEL, READY_LABEL, frontier, parse_blocked_by, read


def task(
    number: int,
    *,
    state: str = "open",
    labels: Optional[Iterable[str]] = (READY_LABEL,),
    assignees: Iterable[str] = (),
    created: str = "2026-10-01T00:00:00Z",
    blockers: Iterable[Dict[str, Any]] = (),
    repo: str = "mock-user/memento",
) -> Dict[str, Any]:
    """A task row as the read builds one."""
    return {
        "repo": repo,
        "number": number,
        "title": f"Task {number}",
        "url": f"https://github.com/{repo}/issues/{number}",
        "state": state,
        "created_at": created,
        "labels": list(labels or ()),
        "assignees": list(assignees),
        "blockers": list(blockers),
    }


def blocker(number: int, state: str = "open", repo: str = "mock-user/memento") -> Dict[str, Any]:
    return {
        "repo": repo,
        "number": number,
        "title": f"Task {number}",
        "url": f"https://github.com/{repo}/issues/{number}",
        "state": state,
    }


class FrontierTests(unittest.TestCase):
    """What AFK offers, over rows and nothing else."""

    def test_an_open_ready_task_nobody_has_is_ready(self) -> None:
        found = frontier([task(265)])
        self.assertEqual([row["number"] for row in found["ready"]], [265])
        self.assertEqual(found["claimed"], [])
        self.assertEqual(found["blocked"], [])

    def test_a_closed_task_is_not_in_the_frontier(self) -> None:
        found = frontier([task(265, state="closed")])
        self.assertEqual(found, {"ready": [], "claimed": [], "blocked": []})

    def test_a_task_without_the_ready_mark_is_not_in_the_frontier(self) -> None:
        found = frontier([task(265, labels=())])
        self.assertEqual(found, {"ready": [], "claimed": [], "blocked": []})

    def test_a_task_assigned_to_anyone_is_claimed(self) -> None:
        found = frontier([task(265, assignees=["someone"])])
        self.assertEqual(found["ready"], [])
        self.assertEqual([row["number"] for row in found["claimed"]], [265])

    def test_a_task_with_the_claim_mark_is_claimed(self) -> None:
        found = frontier([task(265, labels=(READY_LABEL, CLAIM_LABEL))])
        self.assertEqual(found["ready"], [])
        self.assertEqual([row["number"] for row in found["claimed"]], [265])

    def test_a_task_with_an_open_blocker_is_blocked_and_names_it(self) -> None:
        found = frontier([task(266, blockers=[blocker(265)])])
        self.assertEqual(found["ready"], [])
        self.assertEqual([row["number"] for row in found["blocked"]], [266])
        self.assertEqual([found["blocked"][0]["blockers"][0]["number"]], [265])

    def test_a_task_whose_blockers_are_all_closed_is_ready(self) -> None:
        found = frontier([task(266, blockers=[blocker(265, state="closed")])])
        self.assertEqual([row["number"] for row in found["ready"]], [266])
        self.assertEqual(found["blocked"], [])

    def test_a_blocked_row_names_only_the_open_blockers(self) -> None:
        found = frontier(
            [task(268, blockers=[blocker(266, state="closed"), blocker(267)])]
        )
        self.assertEqual([row["number"] for row in found["blocked"][0]["blockers"]], [267])

    def test_ready_tasks_are_oldest_first(self) -> None:
        found = frontier(
            [
                task(3, created="2026-10-03T00:00:00Z"),
                task(1, created="2026-10-01T00:00:00Z"),
                task(2, created="2026-10-02T00:00:00Z"),
            ]
        )
        self.assertEqual([row["number"] for row in found["ready"]], [1, 2, 3])

    def test_a_task_a_person_took_is_claimed_not_ready(self) -> None:
        """An assignee means someone has it, whether or not it's the host's own account."""
        found = frontier([task(265, assignees=["someone", "someone-else"])])
        self.assertEqual(found["ready"], [])
        self.assertEqual(found["claimed"][0]["assignees"], ["someone", "someone-else"])


class BlockedByLineTests(unittest.TestCase):
    """The fallback edge a body carries, on its own."""

    def test_a_line_names_its_issues(self) -> None:
        self.assertEqual(parse_blocked_by("## What to build\n\nBlocked by: #12, #13\n"), [12, 13])

    def test_a_list_bullet_still_reads(self) -> None:
        self.assertEqual(parse_blocked_by("- Blocked by: #7"), [7])

    def test_no_line_names_nothing(self) -> None:
        self.assertEqual(parse_blocked_by("Part of #4. Fixes #9.\n"), [])
        self.assertEqual(parse_blocked_by(None), [])
        self.assertEqual(parse_blocked_by("Blocked by: none"), [])

    def test_a_number_is_named_once(self) -> None:
        self.assertEqual(parse_blocked_by("Blocked by: #12\nBlocked by: #12"), [12])


class ReadTests(unittest.TestCase):
    """The read against the plugin's HTTP stub — no GitHub, no host."""

    def setUp(self) -> None:
        self.home = TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.paths: List[str] = []
        # A checkout, as `_repos` sees one.
        Path(self.home.name, ".git").mkdir()
        self.folders: List[Any] = [Folder(self.home.name)]
        self._patches = [
            patch.object(github, "token", return_value=("token", "env")),
            patch.object(github, "origin_repo", return_value="mock-user/memento"),
        ]
        for one in self._patches:
            one.start()
            self.addCleanup(one.stop)

    def serve(self, answers: Dict[str, Any]) -> None:
        """``github._get`` answering each path prefix with what the test holds, counting reads."""

        def get(path: str, auth: Any) -> Any:
            self.paths.append(path)
            for prefix, answer in answers.items():
                if path.startswith(prefix):
                    if isinstance(answer, Exception):
                        raise answer
                    return answer
            raise AssertionError(f"unexpected read: {path}")

        patcher = patch.object(github, "_get", get)
        patcher.start()
        self.addCleanup(patcher.stop)

    def issue(
        self,
        number: int,
        *,
        state: str = "open",
        body: str = "",
        labels=(READY_LABEL,),
        assignees=(),
        summary: Optional[int] = 0,
        pull_request: bool = False,
    ) -> Dict[str, Any]:
        row = {
            "number": number,
            "title": f"Task {number}",
            "html_url": f"https://github.com/mock-user/memento/issues/{number}",
            "state": state,
            "created_at": "2026-10-01T00:00:00Z",
            "body": body,
            "labels": [{"name": name} for name in labels],
            "assignees": [{"login": login} for login in assignees],
        }
        if summary is not None:
            row["issue_dependencies_summary"] = {"total_blocked_by": summary}
        if pull_request:
            row["pull_request"] = {"url": "https://api.github.com/repos/mock-user/memento/pulls/1"}
        return row

    def test_a_repository_is_asked_once_for_its_ready_tasks(self) -> None:
        self.serve({"/repos/mock-user/memento/issues?": [self.issue(265)]})
        found = read(Path(self.home.name), self.folders)
        self.assertEqual(found["repos"], ["mock-user/memento"])
        self.assertEqual([row["number"] for row in found["ready"]], [265])
        self.assertEqual(len(self.paths), 1)
        self.assertIn(f"labels={READY_LABEL}", self.paths[0])
        self.assertIn("state=open", self.paths[0])

    def test_a_pull_request_is_never_a_task(self) -> None:
        self.serve({"/repos/mock-user/memento/issues?": [self.issue(9, pull_request=True)]})
        found = read(Path(self.home.name), self.folders)
        self.assertEqual(found["ready"], [])

    def test_a_native_edge_is_read_and_its_open_blocker_blocks(self) -> None:
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [self.issue(266, summary=1)],
                "/repos/mock-user/memento/issues/266/dependencies/blocked_by": [
                    self.issue(265)
                ],
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["blocked"]], [266])
        named = [edge["number"] for edge in found["blocked"][0]["blockers"]]
        self.assertEqual(named, [265])

    def test_a_native_edge_that_is_closed_leaves_the_task_ready(self) -> None:
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [self.issue(266, summary=1)],
                "/repos/mock-user/memento/issues/266/dependencies/blocked_by": [
                    self.issue(265, state="closed")
                ],
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["ready"]], [266])

    def test_a_task_without_native_edges_reads_its_body_line(self) -> None:
        """The line is the fallback, and GitHub's own "no edges" summary is what turns it on."""
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [self.issue(266, body="Blocked by: #265", summary=0)],
                "/repos/mock-user/memento/issues/265": self.issue(265, state="closed"),
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["ready"]], [266])
        self.assertEqual(found["blocked"], [])

    def test_an_older_api_without_the_summary_asks_the_edges(self) -> None:
        """Without GitHub's own count, the edges are read to tell "no edges" from "all closed"."""
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [
                    self.issue(266, body="Blocked by: #265", summary=None)
                ],
                "/repos/mock-user/memento/issues/266/dependencies/blocked_by": [],
                "/repos/mock-user/memento/issues/265": self.issue(265),
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["blocked"]], [266])

    def test_a_body_line_naming_an_open_issue_blocks(self) -> None:
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [self.issue(266, body="Blocked by: #265")],
                "/repos/mock-user/memento/issues/265": self.issue(265),
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["blocked"]], [266])

    def test_a_body_line_naming_no_such_issue_blocks_nothing(self) -> None:
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [self.issue(266, body="Blocked by: #999")],
                "/repos/mock-user/memento/issues/999": github.GitHubError("Not Found"),
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["ready"]], [266])

    def test_a_blocker_that_cannot_be_read_keeps_the_task_blocked(self) -> None:
        """An unreadable blocker is not a closed one: working the task early is the worse mistake."""
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [self.issue(266, body="Blocked by: #265")],
                "/repos/mock-user/memento/issues/265": github.GitHubError(
                    "Couldn't reach GitHub from the server."
                ),
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["blocked"]], [266])

    def test_a_project_with_no_github_repository_asks_nothing(self) -> None:
        self.serve({})
        with patch.object(github, "origin_repo", return_value=None):
            found = read(Path(self.home.name), self.folders)
        self.assertEqual(found, {"repos": [], "ready": [], "claimed": [], "blocked": []})
        self.assertEqual(self.paths, [])

    def test_no_github_account_is_refused(self) -> None:
        self.serve({})
        with patch.object(github, "token", return_value=(None, None)):
            with self.assertRaises(github.GitHubError) as raised:
                read(Path(self.home.name), self.folders)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(self.paths, [])

    def test_a_claimed_task_names_no_blockers(self) -> None:
        """It's out of the frontier, so what blocks it is not what the app is told."""
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [
                    self.issue(265, labels=(READY_LABEL, CLAIM_LABEL), summary=0)
                ]
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["claimed"]], [265])
        self.assertNotIn("blockers", found["claimed"][0])


class Folder:
    """A project folder as Hermes's projects.db hands one over."""

    def __init__(self, path: str) -> None:
        self.path = path


if __name__ == "__main__":
    unittest.main()
