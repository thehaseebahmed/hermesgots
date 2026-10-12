"""A pull request whose checks are still running is read again sooner than a settled one."""

import unittest
from pathlib import Path
from unittest.mock import patch

from plugin import github


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
