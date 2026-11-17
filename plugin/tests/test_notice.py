"""What a notification says, and what it is about: the one kind table, and the news that is gone.

Run: python3 -m unittest plugin.tests.test_notice -v
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from plugin import alerts, chats, delegation, failures, merges, notice, push
from plugin.store import connect, db_path


class NoPullRequestNews(unittest.TestCase):
    """G1: nothing about a pull request notifies — not its checks, not its merge, not an AFK one."""

    def test_no_kind_names_a_pull_request(self):
        self.assertEqual(
            [kind for kind in notice.KINDS if "pr" in kind.split("_")],
            [],
            "no kind is a pull request's news",
        )
        self.assertEqual(
            [kind for kind, words in notice.WORDS.items() if "pull request" in words.lower()],
            [],
            "and none of them says one happened",
        )

    def test_no_category_names_a_pull_request(self):
        self.assertEqual(
            [category for category in notice.CATEGORIES if "pr" in category.split("_")],
            [],
            "so no device switches on news nothing sends",
        )


class MergedPullRequest(unittest.TestCase):
    """A merge still resolves its session; it just doesn't say so any more."""

    def merged(self, pushed):
        """A project session whose pull request GitHub answers as merged, and what it told."""
        home = Path(self.tmp.name)
        path = db_path(home)
        conn = connect(path)
        conn.execute(
            "INSERT INTO project_sessions (session_id, project_id, repo_root, path, branch, mode,"
            " plan_pending, created_at, repos) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)",
            (
                "sess-1",
                "p1",
                "/repo",
                "/repo",
                "hermes/sess-1",
                "auto",
                json.dumps(
                    [{"name": "repo", "repo_root": "/repo", "path": "/repo", "branch": "hermes/sess-1"}]
                ),
            ),
        )
        conn.commit()
        conn.close()
        chats.merge(
            path,
            {"chat-1": {"at": 1, "value": {"projectId": "p1", "hermesSessionId": "sess-1", "updatedAt": 1}}},
        )
        with mock.patch.object(
            merges.github,
            "pull_request",
            lambda home, root, branch, **_: {"repo": "o/r", "number": 7, "state": "merged"},
        ), mock.patch("plugin.push.notify", lambda *args, **kwargs: pushed.append(args)):
            return merges.check(home, now=1000)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_a_merged_pull_request_resolves_its_chat_and_pushes_nothing(self):
        pushed = []
        resolved = self.merged(pushed)
        self.assertEqual(resolved, 1, "the merged session is closed on every device")
        entry = chats.one(db_path(Path(self.tmp.name)), "chat-1")
        self.assertEqual(entry["value"]["resolvedAt"], 1000, "with nobody's clock in the answer")
        self.assertEqual(pushed, [], "and nothing about a merge notifies")


class Paragraph(unittest.TestCase):
    """The one rule a run's words are read by: the last paragraph, flattened and cut (G3)."""

    def test_the_last_paragraph_is_flattened(self):
        self.assertEqual(
            notice.paragraph_of("Here is where it stands.\n\n  The parser\n is fixed, and the   tests\n  pass.\n"),
            "The parser is fixed, and the tests pass.",
            "the last thing the reply said, on one line",
        )

    def test_a_long_paragraph_is_cut_with_an_ellipsis(self):
        body = notice.paragraph_of("word " * 200)
        self.assertEqual(len(body), notice.BODY_MAX, "a body is exactly as long as the bound says")
        self.assertTrue(body.endswith("…"), "and says it was cut")

    def test_a_paragraph_that_fits_keeps_its_words(self):
        self.assertEqual(notice.paragraph_of("All of it fits."), "All of it fits.")

    def test_no_words_say_nothing(self):
        for text in (None, "", "  \n\n\t\n \n"):
            self.assertIsNone(notice.paragraph_of(text), "so the kind keeps its own line")


class TheRegistrysBound(unittest.TestCase):
    """A body cut here must not be cut again on the way to Android: one bound, one set of words."""

    def test_the_registry_carries_the_whole_body(self):
        registry = (
            Path(__file__).resolve().parents[2] / "app" / "netlify" / "lib" / "registry.ts"
        ).read_text(encoding="utf-8")
        found = re.search(r"body: text\(input\?\.body, (\d+)\)", registry)
        self.assertIsNotNone(found, "the registry still bounds a detail's body")
        self.assertEqual(int(found.group(1)), notice.BODY_MAX)


class Bodies(unittest.TestCase):
    """What a run's notification says: G3 the reply's last paragraph, G4 the run's error, G2 a hold.

    The hooks are read as Hermes calls them — a turn starts, the model answers, the turn ends —
    over a real store, so the failure a failed run ended with is the row ``failures.after_run``
    wrote. A delegation is stubbed rather than built: what a finished run waits for is its map.
    """

    # A turn this long is news, not something the user was still watching.
    LONG_AGO = alerts.RUN_DONE_MIN_S + 1

    def setUp(self) -> None:
        alerts._started.clear()
        alerts._held.clear()
        alerts._replies.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.path = db_path(self.home)
        connect(self.path).close()
        self.told = []
        for patcher in (
            mock.patch.object(
                push,
                "notify",
                lambda kind, sid, path=None, body=None, **_: self.told.append((kind, sid, body)),
            ),
            mock.patch.object(alerts.sessions, "_paths", lambda: (self.path, self.home)),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def start(self, session: str = "gots-1") -> None:
        """A turn of the session that began long enough ago to be news."""
        alerts.turn_started(session_id=session, platform="api_server")
        alerts._started[session] = time.monotonic() - self.LONG_AGO

    def said(self, text: str, session: str = "gots-1") -> None:
        """The reply the model gave, as ``post_llm_call`` hands it over."""
        alerts.after_llm(session_id=session, platform="api_server", assistant_response=text)

    def end(self, session: str = "gots-1", **flags: bool) -> None:
        alerts.turn_finished(session_id=session, platform="api_server", **flags)

    def finish(self) -> int:
        return alerts.tell_finished(self.path, self.home)

    def at_rest(self):
        """Delegation as it reads once every subagent is gone and its wake has started."""
        return (
            mock.patch.object(delegation, "live_sessions", lambda home: {}),
            mock.patch.object(delegation, "waking_sessions", lambda home: {}),
        )

    def test_a_finished_runs_body_is_the_replys_last_paragraph(self):
        self.start()
        self.said(
            "Here is where the work stands.\n\n"
            "The  parser   is fixed,\nand the tests pass.\n\n"
            "Next: wire  it up.\n"
        )
        at_rest, waking = self.at_rest()
        with at_rest, waking:
            self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(
            self.told,
            [("run_done", "gots-1", "Next: wire it up.")],
            "what happened, under the chat's title",
        )

    def test_a_failed_runs_body_is_the_error_its_run_ended_with(self):
        self.start()
        failures.write(self.path, "gots-1", "429 from the provider: the usage window is spent.", 1)
        self.end(completed=False, failed=True, interrupted=False)
        self.assertEqual(
            self.told,
            [("run_failed", "gots-1", "429 from the provider: the usage window is spent.")],
            "the reason the run ended with, not the kind's own line",
        )

    def test_a_run_held_over_a_subagent_says_nothing_until_it_is_gone(self):
        self.start()
        self.said("Wrote the migration and ran it.\n\nThe  index now covers  the new table.")
        with mock.patch.object(delegation, "live_sessions", lambda home: {"gots-1": 1}):
            self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [], "the run is not over while its subagent works")
        at_rest, waking = self.at_rest()
        with at_rest, waking:
            self.finish()
        self.assertEqual(
            self.told,
            [("run_done", "gots-1", "The index now covers the new table.")],
            "and speaks the words of the turn it ended, long after that turn ended",
        )

    def test_a_subagents_wake_drops_the_held_news_instead_of_announcing_a_run_that_is_running_again(self):
        self.start()
        self.said("Half of it is done; the rest is with the subagent.")
        with mock.patch.object(delegation, "live_sessions", lambda home: {"gots-1": 1}):
            self.end(completed=True, failed=False, interrupted=False)
        # The subagent ended and its wake is still owed: the run is about to resume, not over.
        with mock.patch.object(delegation, "live_sessions", lambda home: {}), mock.patch.object(
            delegation, "waking_sessions", lambda home: {"gots-1": 1}
        ):
            self.finish()
        self.assertEqual(self.told, [], "the gap before the wake turn starts is not the run at rest")
        # The wake turn begins on the session: the run is going again, so its held news is stale.
        alerts.turn_started(session_id="gots-1", platform="api_server")
        at_rest, waking = self.at_rest()
        with at_rest, waking:
            self.finish()
        self.assertEqual(self.told, [], "a run that started again announces nothing of the turn before")
        # The restarted run's own end is the thing that speaks.
        self.said("Done — the migration is in and the tests pass.")
        alerts._started["gots-1"] = time.monotonic() - self.LONG_AGO
        at_rest, waking = self.at_rest()
        with at_rest, waking:
            self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(
            self.told,
            [("run_done", "gots-1", "Done — the migration is in and the tests pass.")],
            "once, and only the run that just ended",
        )


if __name__ == "__main__":
    unittest.main()
