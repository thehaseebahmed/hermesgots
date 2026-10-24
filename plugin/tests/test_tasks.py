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
from plugin.tests._helpers import issue_row
from plugin.tasks import (
    CLAIM_LABEL,
    READY_LABEL,
    frontier,
    groups,
    next_page,
    parse_blocked_by,
    read,
)


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
        found = groups([task(265)])
        self.assertEqual([row["number"] for row in found["ready"]], [265])
        self.assertEqual(found["claimed"], [])
        self.assertEqual(found["blocked"], [])

    def test_a_closed_task_is_not_in_the_frontier(self) -> None:
        found = groups([task(265, state="closed")])
        self.assertEqual(found, {"ready": [], "claimed": [], "blocked": []})

    def test_a_task_without_the_ready_mark_is_not_in_the_frontier(self) -> None:
        found = groups([task(265, labels=())])
        self.assertEqual(found, {"ready": [], "claimed": [], "blocked": []})

    def test_a_task_assigned_to_anyone_is_claimed(self) -> None:
        found = groups([task(265, assignees=["someone"])])
        self.assertEqual(found["ready"], [])
        self.assertEqual([row["number"] for row in found["claimed"]], [265])

    def test_a_task_with_the_claim_mark_is_claimed(self) -> None:
        found = groups([task(265, labels=(READY_LABEL, CLAIM_LABEL))])
        self.assertEqual(found["ready"], [])
        self.assertEqual([row["number"] for row in found["claimed"]], [265])

    def test_a_task_with_an_open_blocker_is_blocked_and_names_it(self) -> None:
        found = groups([task(266, blockers=[blocker(265)])])
        self.assertEqual(found["ready"], [])
        self.assertEqual([row["number"] for row in found["blocked"]], [266])
        self.assertEqual([found["blocked"][0]["blockers"][0]["number"]], [265])

    def test_a_task_whose_blockers_are_all_closed_is_ready(self) -> None:
        found = groups([task(266, blockers=[blocker(265, state="closed")])])
        self.assertEqual([row["number"] for row in found["ready"]], [266])
        self.assertEqual(found["blocked"], [])

    def test_a_blocked_row_names_only_the_open_blockers(self) -> None:
        found = groups([task(268, blockers=[blocker(266, state="closed"), blocker(267)])])
        self.assertEqual([row["number"] for row in found["blocked"][0]["blockers"]], [267])

    def test_ready_tasks_are_oldest_first(self) -> None:
        found = groups(
            [
                task(3, created="2026-10-03T00:00:00Z"),
                task(1, created="2026-10-01T00:00:00Z"),
                task(2, created="2026-10-02T00:00:00Z"),
            ]
        )
        self.assertEqual([row["number"] for row in found["ready"]], [1, 2, 3])

    def test_a_task_a_person_took_is_claimed_not_ready(self) -> None:
        """An assignee means someone has it, whether or not it's the host's own account."""
        found = groups([task(265, assignees=["someone", "someone-else"])])
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


class NextPageTests(unittest.TestCase):
    """GitHub's `Link` header, which is how the read knows a list goes on."""

    def test_a_next_link_names_its_path(self) -> None:
        link = (
            f'<{github.API}/repositories/1/issues?page=2>; rel="next", '
            f'<{github.API}/repositories/1/issues?page=9>; rel="last"'
        )
        self.assertEqual(next_page(link), "/repositories/1/issues?page=2")

    def test_no_header_is_no_next_page(self) -> None:
        self.assertIsNone(next_page(""))
        self.assertIsNone(next_page(None))

    def test_a_header_naming_only_a_previous_page_is_no_next_page(self) -> None:
        self.assertIsNone(next_page(f'<{github.API}/repositories/1/issues?page=1>; rel="prev"'))

    def test_a_link_to_another_host_is_not_followed(self) -> None:
        self.assertIsNone(next_page('<https://example.com/repositories/1/issues?page=2>; rel="next"'))


class ReadTests(unittest.TestCase):
    """The read against the plugin's HTTP stub — no GitHub, no host."""

    def setUp(self) -> None:
        self.home = TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.paths: List[str] = []
        # A checkout, as `repos_of` sees one.
        Path(self.home.name, ".git").mkdir()
        self.folders: List[Any] = [Folder(self.home.name)]
        self._patches = [
            patch.object(github, "token", return_value=("token", "env")),
            patch.object(github, "origin_repo", return_value="mock-user/memento"),
        ]
        for one in self._patches:
            one.start()
            self.addCleanup(one.stop)

    def serve(self, answers: Dict[str, Any], *, links: Optional[Dict[str, str]] = None) -> None:
        """``github._get`` answering each path prefix with what the test holds, counting reads.

        A list read goes through ``github._page``, which carries GitHub's `Link` header beside the
        body, so that one answers the pair; ``links`` gives the header a path should come back with.
        """

        def get(path: str, auth: Any) -> Any:
            self.paths.append(path)
            for prefix, answer in answers.items():
                if path.startswith(prefix):
                    if isinstance(answer, Exception):
                        raise answer
                    return answer
            raise AssertionError(f"unexpected read: {path}")

        def page(path: str, auth: Any) -> Any:
            return get(path, auth), (links or {}).get(path, "")

        for name, answer in (("_get", get), ("_page", page)):
            patcher = patch.object(github, name, answer)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_a_repository_is_asked_once_for_its_ready_tasks(self) -> None:
        self.serve({"/repos/mock-user/memento/issues?": [issue_row(265)]})
        found = read(Path(self.home.name), self.folders)
        self.assertEqual(found["repos"], ["mock-user/memento"])
        self.assertEqual([row["number"] for row in found["ready"]], [265])
        self.assertEqual(len(self.paths), 1)
        self.assertIn(f"labels={READY_LABEL}", self.paths[0])
        self.assertIn("state=open", self.paths[0])

    def test_the_frontier_read_carries_no_bodies(self) -> None:
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [
                    issue_row(265, body="Describe it."),
                    issue_row(266, body="Claimed.", labels=(READY_LABEL, CLAIM_LABEL)),
                    issue_row(267, body="Blocked.", created="2026-10-03T00:00:00Z", summary=1),
                ],
                "/repos/mock-user/memento/issues/267/dependencies/blocked_by": [issue_row(265)],
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual(
            [len(found[group]) for group in ("ready", "claimed", "blocked")],
            [1, 1, 1],
            "one row in each group, so no group is left holding the shape by accident",
        )
        for group in ("ready", "claimed", "blocked"):
            for row in found[group]:
                self.assertNotIn(
                    "body", row, "the sheet shows where the tasks are, not what they say"
                )

    def test_the_sweeps_read_carries_the_body_of_the_one_it_claims(self) -> None:
        body = "## What to build\n\nThe first run opens with the issue.\n\n- verbatim\n"
        self.serve(
            {"/repos/mock-user/memento/issues?": [issue_row(265, body=body), issue_row(266, body="x")]}
        )
        task = frontier(Path(self.home.name), self.folders)[0]
        self.assertEqual((task["number"], task["body"]), (265, body))
        self.assertEqual(len(self.paths), 1, "the body comes with the list, not from a second read")

    def test_the_sweeps_read_of_an_empty_frontier_is_empty(self) -> None:
        self.serve({"/repos/mock-user/memento/issues?": []})
        self.assertEqual(frontier(Path(self.home.name), self.folders), [])

    def test_an_issue_with_no_body_is_an_empty_one(self) -> None:
        self.serve({"/repos/mock-user/memento/issues?": [issue_row(265, body=None)]})
        self.assertEqual(frontier(Path(self.home.name), self.folders)[0]["body"], "")

    def test_a_web_edited_body_reads_with_unix_line_endings(self) -> None:
        self.serve({"/repos/mock-user/memento/issues?": [issue_row(265, body="a\r\n\r\nb\rc")]})
        self.assertEqual(frontier(Path(self.home.name), self.folders)[0]["body"], "a\n\nb\nc")

    def test_a_repository_pages_until_github_offers_no_more(self) -> None:
        first = (
            f"/repos/mock-user/memento/issues?state=open&labels={READY_LABEL}"
            "&sort=created&direction=asc&per_page=100"
        )
        second = f"{first}&page=2"
        self.serve(
            # The narrower prefix first: a later page answers its own rows.
            {second: [issue_row(266)], first: [issue_row(265)]},
            links={first: f'<{github.API}{second}>; rel="next"'},
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["ready"]], [265, 266])
        self.assertEqual(self.paths, [first, second])

    def test_a_link_pointing_back_at_the_page_read_is_not_followed(self) -> None:
        first = (
            f"/repos/mock-user/memento/issues?state=open&labels={READY_LABEL}"
            "&sort=created&direction=asc&per_page=100"
        )
        self.serve({first: [issue_row(265)]}, links={first: f'<{github.API}{first}>; rel="next"'})
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["ready"]], [265])
        self.assertEqual(self.paths, [first])

    def test_a_pull_request_is_never_a_task(self) -> None:
        self.serve({"/repos/mock-user/memento/issues?": [issue_row(9, pull_request=True)]})
        found = read(Path(self.home.name), self.folders)
        self.assertEqual(found["ready"], [])

    def test_a_native_edge_is_read_and_its_open_blocker_blocks(self) -> None:
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [issue_row(266, summary=1)],
                "/repos/mock-user/memento/issues/266/dependencies/blocked_by": [
                    issue_row(265)
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
                "/repos/mock-user/memento/issues?": [issue_row(266, summary=1)],
                "/repos/mock-user/memento/issues/266/dependencies/blocked_by": [
                    issue_row(265, state="closed")
                ],
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["ready"]], [266])

    def test_a_task_without_native_edges_reads_its_body_line(self) -> None:
        """The line is the fallback, and GitHub's own "no edges" summary is what turns it on."""
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [issue_row(266, body="Blocked by: #265", summary=0)],
                "/repos/mock-user/memento/issues/265": issue_row(265, state="closed"),
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
                    issue_row(266, body="Blocked by: #265", summary=None)
                ],
                "/repos/mock-user/memento/issues/266/dependencies/blocked_by": [],
                "/repos/mock-user/memento/issues/265": issue_row(265),
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["blocked"]], [266])

    def test_a_body_line_naming_an_open_issue_blocks(self) -> None:
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [issue_row(266, body="Blocked by: #265")],
                "/repos/mock-user/memento/issues/265": issue_row(265),
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["blocked"]], [266])

    def test_a_body_line_naming_no_such_issue_blocks_nothing(self) -> None:
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [issue_row(266, body="Blocked by: #999")],
                "/repos/mock-user/memento/issues/999": github.GitHubError("Not Found"),
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["ready"]], [266])

    def test_a_blocker_that_cannot_be_read_keeps_the_task_blocked(self) -> None:
        """An unreadable blocker is not a closed one: working the task early is the worse mistake."""
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [issue_row(266, body="Blocked by: #265")],
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

    def test_a_claimed_task_names_no_blockers_and_is_asked_none(self) -> None:
        """It's out of the frontier, so what blocks it is neither read nor told to the app."""
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [
                    issue_row(265, labels=(READY_LABEL, CLAIM_LABEL), summary=2)
                ],
                "/repos/mock-user/memento/issues/265/dependencies/blocked_by": [],
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["claimed"]], [265])
        self.assertEqual(found["claimed"][0]["blockers"], [])
        # The summary says it has edges; a claim means they're never worth a request.
        self.assertEqual(len(self.paths), 1, self.paths)

    def test_a_task_whose_blockers_are_all_closed_asks_no_edges(self) -> None:
        """``blocked_by`` counts the open ones, so a zero settles it without a second request."""
        self.serve(
            {
                "/repos/mock-user/memento/issues?": [
                    issue_row(266, summary=3, open_edges=0)
                ],
            }
        )
        found = read(Path(self.home.name), self.folders)
        self.assertEqual([row["number"] for row in found["ready"]], [266])
        self.assertEqual(len(self.paths), 1, self.paths)


class Folder:
    """A project folder as Hermes's projects.db hands one over."""

    def __init__(self, path: str) -> None:
        self.path = path


if __name__ == "__main__":
    unittest.main()
