"""A screen's pull requests in one read: a batch answers every session it was asked about, a few at
a time and within a deadline, and names the sessions it couldn't answer for rather than failing the
whole read (ADR 0087)."""

import asyncio
import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest import mock

from plugin import github
from plugin.tests._helpers import App, Context, FakeWeb


class Query:
    """The little of ``request.query`` the handler reads: one parameter, repeated."""

    def __init__(self, given):
        self.given = given

    def getall(self, name, default=None):
        found = [one for key, one in self.given if key == name]
        return found or ([] if default is None else default)


class Adapter:
    """The API server's adapter, as far as this route reaches into it."""

    def __init__(self):
        self._run_statuses = {}

    def _check_auth(self, request):
        return None


RECORD = {"repos": [{"path": "/repo", "repo_root": "/repo", "branch": "hermes/x"}]}


class PrsBatchTests(unittest.TestCase):
    def setUp(self):
        import plugin

        self.plugin = plugin
        aiohttp = ModuleType("aiohttp")
        aiohttp.web = FakeWeb()
        constants = ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: "/home"
        planted = {
            "aiohttp": aiohttp,
            "aiohttp.web": aiohttp.web,
            "hermes_constants": constants,
        }
        wiring = mock.patch.dict(sys.modules, planted)
        wiring.start()
        self.addCleanup(wiring.stop)

        for one in (
            mock.patch.object(plugin, "current_path", return_value=Path("/store")),
            mock.patch.object(
                plugin.sessions, "record_for", return_value=RECORD
            ),
            mock.patch.object(github, "MAX_OUTBOUND", 2),
            mock.patch.object(plugin, "PRS_BATCH_DEADLINE_S", 5.0),
        ):
            one.start()
            self.addCleanup(one.stop)

        # A pool per test, made on first use so it takes the `MAX_OUTBOUND` this test patched; the
        # plugin drops it afterwards, so its threads don't outlive the case that made them.
        self.addCleanup(plugin._drop_chains)

        self.app, self.adapter = App(), Adapter()
        context = Context()
        plugin.register(context)
        context.platforms["api_server"](self.app, self.adapter)

    def route(self):
        for _method, registered, handler in self.app.router.added:
            if registered == self.plugin.PREFIX + "/prs":
                return handler
        raise AssertionError("the plugin registered no batch read of pull requests")

    def read(self, sessions):
        request = FakeWeb.Request()
        request.match_info = {}
        request.headers = {}
        request.query = Query([("session", one) for one in sessions])
        return asyncio.run(self.route()(request))

    def test_every_session_asked_about_is_answered_by_id(self):
        with mock.patch.object(
            github,
            "pull_requests",
            lambda home, root, branch, **rest: [
                {"repo": "me/app", "number": 1, "title": "t", "url": None, "state": "open", "checks": None}
            ],
        ):
            answer = self.read(["s-a", "s-b"])
        self.assertEqual(answer["status"], 200)
        self.assertEqual(sorted(answer["payload"]["prs"]), ["s-a", "s-b"])
        self.assertEqual(answer["payload"]["unread"], [])

    def test_a_session_that_cannot_be_read_is_named_not_failed(self):
        def read(home, root, branch, **rest):
            raise github.GitHubError("Couldn't reach GitHub from the server.")

        with mock.patch.object(github, "pull_requests", read):
            answer = self.read(["s-a"])
        self.assertEqual(answer["status"], 200, "one session's failure doesn't fail the read")
        self.assertEqual(answer["payload"]["prs"], {})
        self.assertEqual(answer["payload"]["unread"], ["s-a"])

    def test_a_session_the_store_does_not_know_is_unread_not_empty(self):
        with mock.patch.object(self.plugin.sessions, "record_for", return_value=None):
            answer = self.read(["s-gone"])
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["prs"], {})
        self.assertEqual(answer["payload"]["unread"], ["s-gone"])

    def test_the_read_spends_no_more_than_its_workers_at_once(self):
        running = []
        peak = []

        def read(home, root, branch, **rest):
            running.append(branch)
            peak.append(len(running))
            try:
                import time

                time.sleep(0.05)
            finally:
                running.remove(branch)
            return []

        with mock.patch.object(github, "pull_requests", read):
            self.read([f"s-{n}" for n in range(8)])
        # What binds here is the batch's own slots — `pull_requests` is this test's own stand-in, so
        # the outbound ceiling behind it never runs. That ceiling has its own test in `test_pr_cache`.
        self.assertLessEqual(
            max(peak),
            github.MAX_OUTBOUND,
            "the batch never had more sessions in flight than its slots",
        )

    def test_a_read_past_the_deadline_is_answered_unread(self):
        import time

        def slow(home, root, branch, **rest):
            time.sleep(0.3)
            return []

        with mock.patch.object(github, "pull_requests", slow), mock.patch.object(
            self.plugin, "PRS_BATCH_DEADLINE_S", 0.05
        ):
            answer = self.read(["s-a"])
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["unread"], ["s-a"], "a read too slow is left unread")

    def test_a_batch_chain_runs_on_its_own_workers(self):
        import threading

        names = []

        def read(home, root, branch, **rest):
            names.append(threading.current_thread().name)
            return []

        with mock.patch.object(github, "pull_requests", read):
            self.read([f"s-{n}" for n in range(4)])
        self.assertTrue(names, "the batch read something")
        self.assertTrue(
            all(name.startswith("memento-prs") for name in names),
            f"a batch's chains run on the batch's own workers, not the executor every other route "
            f"shares: {sorted(set(names))}",
        )

    def test_a_closed_session_is_named_unread_and_costs_no_chain(self):
        reads = []

        def read(home, root, branch, **rest):
            reads.append(branch)
            return []

        with mock.patch.object(
            self.plugin.chats, "closed_sessions", return_value={"s-a"}
        ), mock.patch.object(github, "pull_requests", read):
            answer = self.read(["s-a"])
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["prs"], {})
        self.assertEqual(answer["payload"]["unread"], ["s-a"])
        self.assertEqual(reads, [], "a closed session's branch is not read at all")

    def test_no_session_named_is_a_refused_read(self):
        answer = self.read([])
        self.assertEqual(answer["status"], 400)


if __name__ == "__main__":
    unittest.main()
