"""A pull request whose checks are still running is read again sooner than a settled one, and a
branch's whole history comes back — its finished pull requests without checks."""

import unittest
from pathlib import Path
from unittest.mock import patch

from plugin import github


def pr_row(number, state="open", merged=False, draft=False):
    """A pulls-list row as GitHub answers one."""
    return {
        "number": number,
        "title": f"#{number}",
        "html_url": f"u{number}",
        "state": state,
        "draft": draft,
        "merged_at": "2026-01-01T00:00:00Z" if merged else None,
        "head": {"sha": f"sha{number}"},
    }


class FakeClock:
    """``time`` for the cache: only ``time()`` matters here."""

    def __init__(self):
        self.now = 1_000.0

    def time(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class PrCacheTests(unittest.TestCase):
    def setUp(self):
        github._pr_cache.clear()
        self.reads = 0
        self.clock = FakeClock()
        self._patches = [
            patch.object(github, "time", self.clock),
            patch.object(github, "origin_repo", return_value="mock-user/memento"),
            patch.object(github, "token", return_value=(None, None)),
        ]
        for one in self._patches:
            one.start()
        self.addCleanup(self._stop)

    def _stop(self):
        for one in self._patches:
            one.stop()
        github._pr_cache.clear()

    def _answer(self, conclusion):
        """``_get`` serving the pulls, check-runs and status calls; counts every read."""

        def get(path, auth):
            self.reads += 1
            if "/check-runs" in path:
                running = conclusion == "pending"
                return {
                    "check_runs": [
                        {
                            "status": "queued" if running else "completed",
                            "conclusion": None if running else conclusion,
                        }
                    ]
                }
            if path.endswith("/status"):
                return {"total_count": 0}
            return [
                {
                    "number": 27,
                    "title": "t",
                    "html_url": "u",
                    "state": "open",
                    "draft": False,
                    "merged_at": None,
                    "head": {"sha": "abc"},
                }
            ]

        return patch.object(github, "_get", get)

    def _read(self, conclusion):
        with self._answer(conclusion):
            pr = github.pull_request(Path("/fake/home"), "/repo", "branch")
        assert pr is not None
        return pr

    def _failing(self):
        """``_get`` refusing: the server can't reach GitHub."""

        def get(path, auth):
            self.reads += 1
            raise github.GitHubError("Couldn't reach GitHub from the server.")

        return patch.object(github, "_get", get)

    def _rows(self, rows):
        """``_get`` serving a branch's pulls as GitHub answers them; counts every read."""

        def get(path, auth):
            self.reads += 1
            if "/check-runs" in path:
                return {"check_runs": [{"status": "completed", "conclusion": "success"}]}
            if path.endswith("/status"):
                return {"total_count": 0}
            return rows

        return patch.object(github, "_get", get)

    def test_a_branchs_pull_requests_all_come_back(self):
        rows = [pr_row(28), pr_row(27, state="closed", merged=True)]
        with self._rows(rows):
            found = github.pull_requests(Path("/fake/home"), "/repo", "branch")
        self.assertEqual(
            [pr["number"] for pr in found], [28, 27], "every one of them, newest first"
        )
        self.assertEqual(found[1]["state"], "merged", "a finished one keeps its state")

    def test_only_a_live_pull_request_has_its_checks_read(self):
        rows = [pr_row(28), pr_row(27, state="closed", merged=True)]
        with self._rows(rows):
            found = github.pull_requests(Path("/fake/home"), "/repo", "branch")
        self.assertEqual(found[0]["checks"], "success", "the open one's checks are read")
        self.assertIsNone(found[1]["checks"], "a merged one's aren't: they don't matter any more")

    def test_the_newest_pull_request_is_the_one_a_caller_gets(self):
        rows = [pr_row(28), pr_row(27, state="closed", merged=True)]
        with self._rows(rows):
            newest = github.pull_request(Path("/fake/home"), "/repo", "branch")
        assert newest is not None
        self.assertEqual(newest["number"], 28)

    def test_a_branch_with_no_pull_requests_answers_nothing(self):
        with self._rows([]):
            self.assertEqual(github.pull_requests(Path("/fake/home"), "/repo", "branch"), [])
            self.assertIsNone(github.pull_request(Path("/fake/home"), "/repo", "branch"))

    def test_a_failure_answers_none_unless_strict(self):
        with self._failing():
            self.assertIsNone(
                github.pull_request(Path("/fake/home"), "/repo", "branch"),
                "the lenient read still answers None",
            )
            with self.assertRaises(github.GitHubError):
                github.pull_request(Path("/fake/home"), "/repo", "branch", strict=True)

    def test_a_failure_is_never_cached(self):
        with self._failing():
            self.assertIsNone(github.pull_request(Path("/fake/home"), "/repo", "branch"))
            with self.assertRaises(github.GitHubError):
                github.pull_request(Path("/fake/home"), "/repo", "branch", strict=True)
        self.assertEqual(github._pr_cache, {}, "a failure must not be cached as an answer")
        self.assertEqual(
            self._read("success")["number"], 27, "the read after it still goes out and finds the PR"
        )

    def test_pending_checks_expire_at_the_short_window(self):
        self.assertEqual(self._read("pending")["checks"], "pending")
        reads = self.reads
        self.clock.advance(github.PR_PENDING_CACHE_S + 1)
        self._read("pending")
        self.assertGreater(self.reads, reads, "running checks must be read again at once")
        reads = self.reads
        self.clock.advance(github.PR_PENDING_CACHE_S + 1)
        self._read("pending")
        self.assertGreater(self.reads, reads, "and again while they still run")

    def test_settled_checks_keep_the_long_window(self):
        self.assertEqual(self._read("success")["checks"], "success")
        reads = self.reads
        self.clock.advance(github.PR_PENDING_CACHE_S + 1)
        self._read("success")
        self.assertEqual(self.reads, reads, "a settled pull request outlives the short window")
        self.clock.advance(github.PR_CACHE_S)
        self._read("success")
        self.assertGreater(self.reads, reads)

    def test_failing_checks_keep_the_long_window(self):
        self.assertEqual(self._read("failure")["checks"], "failure")
        reads = self.reads
        self.clock.advance(github.PR_PENDING_CACHE_S + 1)
        self._read("failure")
        self.assertEqual(self.reads, reads)
        self.clock.advance(github.PR_CACHE_S)
        self._read("failure")
        self.assertGreater(self.reads, reads)


if __name__ == "__main__":
    unittest.main()
