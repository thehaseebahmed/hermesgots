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
from types import SimpleNamespace
from unittest import mock

from plugin import alerts, chats, clarify, delegation, failures, merges, notice, push
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


class TheRecord(unittest.TestCase):
    """The repo's own record says what the plugin does: G1 cut the pull-request news from it too.

    AGENTS.md and `plugin/README.md` are where a reader learns the push table, and they outlived
    three kinds and three categories that went with the pull-request news: a reader found switches
    no device has, and a body described as one sentence per kind when a notice carries its own.
    """

    DOCS = ("AGENTS.md", "plugin/README.md")
    GONE = ("pr_checks", "pr_merged", "afk_pr", "code_pr_checks", "code_pr_merged", "code_afk_pr")

    def read(self, name: str) -> str:
        return (Path(__file__).resolve().parents[2] / name).read_text(encoding="utf-8")

    def test_no_doc_names_a_pull_request_notification(self) -> None:
        for name in self.DOCS:
            said = self.read(name)
            for gone in self.GONE:
                # A word of its own, since `afk_prompt` and `afk_picks` are not `afk_pr`.
                self.assertIsNone(
                    re.search(rf"(?<![a-z_]){re.escape(gone)}(?![a-z_])", said),
                    f"{name} still names {gone}, which nothing sends",
                )

    def test_the_record_names_every_category_the_plugin_has(self) -> None:
        agents = self.read("AGENTS.md")
        for category in notice.CATEGORIES:
            self.assertIn(f"`{category}`", agents, f"AGENTS.md names the category {category}")


class MergedPullRequest(unittest.TestCase):
    """A merge resolves its session on every device, and tells no device."""

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


class AnApprovalsBody(unittest.TestCase):
    """G5: an approval's body is the card's own — its description, then the command it asks about."""

    def test_an_approvals_body_is_its_description_over_its_command(self):
        self.assertEqual(
            notice.approval_body("Clear the build", "rm -rf build"),
            "Clear the build\n\nrm -rf build",
            "what the card says, with the command standing under the description",
        )

    def test_a_multi_line_command_keeps_its_lines(self):
        command = "python3 - <<'PY'\n  print('one')   \n\n\n\n  print('two')\nPY\n"
        self.assertEqual(
            notice.approval_body(None, command),
            "python3 - <<'PY'\n  print('one')\n\n  print('two')\nPY",
            "a heredoc stays readable: each line as it was, its trailing spaces gone, its blanks one",
        )

    def test_an_approval_with_a_description_and_no_command_says_the_description(self):
        self.assertEqual(
            notice.approval_body("Clear the build", None),
            "Clear the build",
            "a card with no command to show still says what it asks",
        )

    def test_a_command_longer_than_the_bound_is_cut_with_an_ellipsis(self):
        body = notice.approval_body(None, "echo " + "word " * 400)
        self.assertLessEqual(len(body), notice.APPROVAL_MAX, "a command's body is held to its bound")
        self.assertGreater(
            len(body),
            notice.BODY_MAX,
            "and that bound is a command's, not the sentence a reply's paragraph is cut to — "
            "the card shows the whole command, so a tray has to hold more than a sentence of it",
        )
        self.assertTrue(body.endswith("…"), "and says it was cut")

    def test_a_long_command_is_cut_at_a_line_and_never_mid_token(self):
        command = "\n".join(f"step {n}: run the {n}th check" for n in range(200))
        body = notice.approval_body(None, command)
        self.assertLessEqual(len(body), notice.APPROVAL_MAX)
        self.assertTrue(body.endswith("…"), "a cut body says so")
        kept = body[:-1].split("\n")
        self.assertEqual(
            kept,
            command.split("\n")[: len(kept)],
            "every line it keeps is a line of the command, whole",
        )
        self.assertEqual(kept[-1], f"step {len(kept) - 1}: run the {len(kept) - 1}th check")

    def test_an_approval_that_says_nothing_answers_nothing(self):
        for description, command in ((None, None), ("  \n", "\n \n"), ("", "")):
            self.assertIsNone(notice.approval_body(description, command), "so the kind keeps its line")


class AQuestion(unittest.TestCase):
    """G6: a question's notification is the question, and nothing else rides it.

    Driven through the agent's own ``clarify`` callback over a stub run, with the wait itself stubbed:
    what the notification says is decided before it waits, and is the only thing this reads.
    """

    def setUp(self) -> None:
        self.told: list = []
        self.agent = SimpleNamespace(session_id="gots-1")
        for patcher in (
            mock.patch.object(clarify, "_run_id", lambda adapter, agent: "run-1"),
            mock.patch.object(clarify, "_run_status", lambda adapter, run_id: "running"),
            mock.patch.object(clarify, "_set_status", lambda *args, **kwargs: None),
            mock.patch.object(clarify, "_wait", lambda pending, agent, adapter: "timed_out"),
            mock.patch.object(
                clarify.push,
                "notify",
                lambda kind, session_id, **kw: self.told.append((kind, session_id, kw)),
            ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_a_questions_body_is_the_question_and_it_carries_no_action(self):
        asker = clarify.Asker(SimpleNamespace(_run_streams={}), self.agent, loop=None)
        asker.ask(
            [
                {"qid": "q0", "question": "Which database?", "choices_offered": ["Postgres", "SQLite"]},
                {"qid": "q1", "question": "And which region?"},
            ]
        )
        self.assertEqual(
            self.told,
            [("question", "gots-1", {"body": "Which database?"})],
            "the question alone: not the choices, not the second one, and no button to press",
        )


class TheRegistrysBound(unittest.TestCase):
    """A body cut here must not be cut again on the way to Android: one bound, one set of words."""

    def test_the_registry_carries_the_whole_body(self):
        registry = (
            Path(__file__).resolve().parents[2] / "app" / "netlify" / "lib" / "registry.ts"
        ).read_text(encoding="utf-8")
        found = re.search(r"body: text\(input\?\.body, (\d+)\)", registry)
        self.assertIsNotNone(found, "the registry still bounds a detail's body")
        self.assertLessEqual(notice.BODY_MAX, notice.APPROVAL_MAX, "a command has the longer bound")
        self.assertEqual(
            int(found.group(1)),
            notice.APPROVAL_MAX,
            "a body cut here must not be cut again on the way to Android, and an approval's command "
            "is the longest one the plugin sends",
        )

    def test_the_phone_holds_the_notice_as_long_as_the_push(self):
        """A button lives as long as the tray entry it rode on, and Android is told by the message."""
        message = (
            Path(__file__).resolve().parents[2] / "app" / "netlify" / "lib" / "fcm.ts"
        ).read_text(encoding="utf-8")
        found = re.search(r'ttl: "(\d+)s"', message)
        self.assertIsNotNone(found, "the message still carries the notice's lifetime")
        self.assertEqual(
            int(found.group(1)),
            push.TTL_SECONDS,
            "the tray entry outlives its buttons, or dies before them",
        )


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
        alerts._resumed.clear()
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

    def test_a_failed_turn_that_keeps_no_words_does_not_repeat_an_older_turns_error(self):
        """A wordless failure says the kind's own line, never the error of the turn before it.

        ``failures.after_run`` used to write only when it had words, so an older failed turn's row
        survived this one: the notice stated an error this run never ended with, and the app drew
        it under the failed reply.
        """
        self.start()
        # An earlier turn failed with the provider's own words, kept where every device may read them.
        failures.write(self.path, "gots-1", "429 from the provider: the usage window is spent.", 1)
        # This turn failed with nothing worth saying — Hermes's own wordless notice, which
        # `failures.reason_of` leaves behind rather than keeping.
        book = SimpleNamespace(
            _run_statuses={
                "run_2": {
                    "status": "failed",
                    "session_id": "gots-1",
                    "error": "Agent run failed",
                    "updated_at": 2,
                }
            }
        )
        with mock.patch.object(alerts.sessions, "adapter", book), mock.patch.object(
            alerts.sessions, "record_for", lambda *args: {"mode": "auto"}
        ):
            failures.after_run(
                session_id="gots-1", platform="api_server", failed=True, interrupted=False
            )
        self.assertIsNone(
            failures.read(self.path, "gots-1"), "a failure that kept nothing keeps nothing at all"
        )
        self.end(completed=False, failed=True, interrupted=False)
        self.assertEqual(
            self.told,
            [("run_failed", "gots-1", None)],
            "so the notice falls back to the kind's own line, which every transport knows",
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

    def test_a_wake_turn_that_resumes_the_run_speaks_however_short_it_was(self):
        """A wake is seconds long, and its end is the run's only news.

        The turn that ended over a live subagent parked its words; the wake drops them because the
        run went on. That run's end is then everything the user has not heard, so the short-run
        floor — which keeps a chat's own quick turn quiet — cannot swallow it. Nothing is backdated
        here: the wake's own start is the clock its end is judged against.
        """
        self.start()
        self.said("Half of it is done; the rest is with the subagent.")
        with mock.patch.object(delegation, "live_sessions", lambda home: {"gots-1": 1}):
            self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [], "the subagent still works, so nothing is said yet")
        # The wake resumes the conversation: the hold is dropped, and the turn lasts seconds.
        alerts.turn_started(session_id="gots-1", platform="api_server")
        self.said("Done — the migration is in and the tests pass.")
        at_rest, waking = self.at_rest()
        with at_rest, waking:
            self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(
            self.told,
            [("run_done", "gots-1", "Done — the migration is in and the tests pass.")],
            "the run resumed, so its own end is news however short that turn was",
        )
        # The floor still holds for a run that resumed nothing: a chat's own quick turn is quiet.
        alerts.turn_started(session_id="gots-2", platform="api_server")
        self.said("ok", session="gots-2")
        with at_rest, waking:
            self.end(session="gots-2", completed=True, failed=False, interrupted=False)
        self.assertEqual(len(self.told), 1, "a short turn that held nothing is still not news")


if __name__ == "__main__":
    unittest.main()
