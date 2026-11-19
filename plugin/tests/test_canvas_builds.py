"""A canvas's requests are builds: one request, one session, one version published (ADR 0170).

Run: python3 -m unittest plugin.tests.test_canvas_builds -v
"""

from __future__ import annotations

import asyncio
import json
import unittest
from typing import Any, Dict, List, Optional
from unittest import mock

from plugin import builds, canvases, outbox, progress
from plugin.store import db_path, put_setting
from plugin.tests._helpers import RouteAdapter, temp_hermes_home, wire

PROMPT = "A tip calculator for a restaurant bill, in the app's own colours"
BODY = {"model": "m", "input": [{"role": "user", "content": PROMPT}]}

DOCUMENT = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tip</title></head>
<body><h1>Tip</h1></body>
</html>"""

TWEAKED = DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split the bill</h1>")
SUMMARY = "The heading now says Split the bill."


class Adapter:
    """The API server as far as the queue's dispatcher reaches: the runs of each session."""

    def __init__(self) -> None:
        self._run_statuses: Dict[str, dict] = {}

    def run(self, run_id: str, session_id: str, status: str, at: float = 1) -> None:
        self._run_statuses[run_id] = {
            "run_id": run_id,
            "session_id": session_id,
            "status": status,
            "created_at": at,
            "updated_at": at,
        }


class Host:
    """A wired plugin over a throwaway home, with one canvas whose requests are builds.

    A canvas is made with its first turn queued on its chat, so ``start`` — one tick of the
    dispatcher — is what opens the first build, exactly as a request sent later would.
    """

    def __init__(self, case: unittest.TestCase, builds_on: bool = True) -> None:
        self.home = temp_hermes_home(case)
        self.app = wire(case, RouteAdapter())
        self.path = db_path(self.home)
        self.adapter = Adapter()
        self.canvas = canvases.create(
            self.path,
            request_profile="default",
            bot_id="bot-1",
            prompt=PROMPT,
            body=BODY,
            builds=builds_on,
        )
        self.session = self.canvas["session_id"]
        self.posted: List[Dict[str, Any]] = []

        async def post(adapter, profile, path, body, authorization=None, idempotency_key=None):
            self.posted.append({"path": path, "body": body, "key": idempotency_key})
            return {"run_id": f"run_{len(self.posted)}"}

        posting = mock.patch.object(outbox, "post", post)
        posting.start()
        case.addCleanup(posting.stop)
        # A build's run is keyed on the build's own session, so the dispatcher's "is anything
        # running" has to answer for that session as well as the canvas chat's.
        ids = mock.patch.object(outbox, "session_ids", self.session_ids)
        ids.start()
        case.addCleanup(ids.stop)

    async def session_ids(self, adapter: Any, session_id: str) -> set:
        found = {session_id}
        build = builds.of_canvas(self.path, self.id)
        if build is not None:
            found.add(build["session_id"])
        return found

    @property
    def id(self) -> str:
        return self.canvas["id"]

    def tick(self) -> None:
        asyncio.run(outbox.tick(self.adapter, self.session, None, self.path))

    def queue(self, text: str) -> dict:
        return outbox.add(
            self.path, self.session, None, text, [], dict(BODY, session_id=self.session)
        )

    def start(self) -> Dict[str, Any]:
        """The canvas's first request becomes a build: one tick of the dispatcher."""
        self.tick()
        build = self.build()
        assert build is not None, "the first request opened a build"
        self.adapter.run("run_1", build["session_id"], "running", 2)
        return build

    def build(self) -> Optional[Dict[str, Any]]:
        return builds.of_canvas(self.path, self.id)

    def newest(self) -> Dict[str, Any]:
        return builds.builds_of(self.path, self.id)[0]

    def write(self, session: str, html: str = TWEAKED) -> Dict[str, Any]:
        return json.loads(canvases.handle_write({"html": html}, session_id=session))

    def end(self, session: str, **outcome: Any) -> None:
        """The build's run ends as ``outcome`` says, with the reply it gave before it."""
        builds.reply(session_id=session, assistant_response=SUMMARY)
        builds.ended(session_id=session, **outcome)

    def version(self) -> int:
        return canvases.page(self.path, self.id)["version"]

    def document(self) -> str:
        return canvases.page(self.path, self.id)["html"]

    def record(self) -> Dict[str, Any]:
        return canvases.current(self.path, self.id, documents=False)

    def waiting(self) -> List[str]:
        return [item["text"] for item in outbox.read(self.path, self.session)["items"]]


class ABuildPublishesOnceTest(unittest.TestCase):
    """The plan's first check: a small tweak builds, checks and publishes one version.

    The checks are stubbed absent here — a test host has no browser layer, which is step 10's own
    ground — so what is proved is the build itself: the request opens a build on a session of its
    own, the agent's writes land in the draft, and the run's end publishes exactly one version
    carrying the request and the reply as its summary.
    """

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_small_tweak_builds_and_publishes_one_version(self) -> None:
        build = self.host.start()
        self.assertEqual(self.host.posted[-1]["body"]["session_id"], build["session_id"])
        self.assertEqual(build["requests"], [PROMPT])
        self.assertEqual(self.host.version(), 0, "nothing is published while the build works")

        written = self.host.write(build["session_id"])
        self.assertTrue(written["written"])
        self.assertTrue(written["draft"], "a build writes the draft, not a version")
        read = json.loads(canvases.handle_read({}, session_id=build["session_id"]))
        self.assertEqual(read["html"], TWEAKED)
        self.assertEqual(self.host.version(), 0)

        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.version(), 1, "one build, one version")
        self.assertEqual(self.host.document(), TWEAKED)
        published = self.host.newest()
        self.assertEqual(published["phase"], builds.PUBLISHED)
        self.assertEqual(published["summary"], SUMMARY)
        self.assertEqual(self.host.record()["requests"], [PROMPT])
        self.assertEqual(self.host.record()["summary"], SUMMARY)
        self.assertIsNone(self.host.build(), "the build is closed once it has published")
        self.assertIsNone(canvases.draft(self.host.path, self.host.id))

    def test_the_seed_carries_the_page_the_memory_and_the_summaries(self) -> None:
        canvases.write(self.host.path, self.host.id, DOCUMENT)
        canvases.keep(self.host.path, self.host.id, canvases.MEMORY, "Split at the table.")
        seeded = builds.seed(self.host.path, self.host.id)
        self.assertIn(DOCUMENT, seeded, "the page rides the seed whole")
        self.assertIn("Split at the table.", seeded)
        self.assertIn("canvas_write", seeded)
        # The seed is the run's own instructions, told once per build.
        self.host.start()
        self.assertEqual(self.host.posted[-1]["body"]["instructions"], seeded)
        self.assertEqual(self.host.posted[-1]["body"]["session_id"], self.host.build()["session_id"])
        # A second build on the same canvas carries the first one's summary in its seed.
        build = self.host.build()
        self.host.write(build["session_id"])
        self.host.end(build["session_id"], completed=True)
        self.host.queue("make the heading say Split the bill")
        self.host.tick()
        second = builds.seed(self.host.path, self.host.id)
        self.assertIn(SUMMARY, second, "the newest summaries ride the next build's seed")

    def test_a_build_that_writes_nothing_publishes_nothing(self) -> None:
        build = self.host.start()
        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.version(), 0, "no draft, no version")
        self.assertEqual(self.host.newest()["phase"], builds.PUBLISHED)

    def test_undo_after_one_build_moves_back_the_whole_build(self) -> None:
        canvases.write(self.host.path, self.host.id, DOCUMENT)
        build = self.host.start()
        self.host.write(build["session_id"])
        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.version(), 2)
        # One build, one version: an undo takes the whole build back, not one write inside it.
        canvases.undo(self.host.path, self.host.id)
        self.assertEqual(self.host.version(), 1)
        self.assertEqual(self.host.document(), DOCUMENT)


class ARequestSentMidBuildTest(unittest.TestCase):
    """The plan's second check: a request sent while a build is open runs on that build's session."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_request_sent_mid_build_runs_on_the_open_builds_session(self) -> None:
        build = self.host.start()

        # A second request while the build works: it waits, and starts no run of its own.
        self.host.queue("and make it blue too")
        self.host.tick()
        self.assertEqual(len(self.host.posted), 1, "no second run beside the build")
        self.assertEqual(self.host.waiting(), ["and make it blue too"])

        # The run ends with that request still waiting, so the build carries on rather than
        # publishing under it, and the request becomes the build's next turn.
        self.host.adapter.run("run_1", build["session_id"], "completed", 3)
        builds.ended(session_id=build["session_id"], completed=True)
        self.assertEqual(self.host.build()["phase"], builds.OPEN)
        self.host.tick()
        self.assertEqual(len(self.host.posted), 2)
        self.assertEqual(self.host.posted[-1]["body"]["session_id"], build["session_id"])
        self.assertEqual(self.host.build()["requests"], [PROMPT, "and make it blue too"])

        # The turn that ends the build carries both requests on the one version it publishes.
        self.host.write(build["session_id"])
        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.record()["requests"], [PROMPT, "and make it blue too"])

    def test_a_request_sent_after_a_build_published_opens_the_next_one(self) -> None:
        first = self.host.start()
        self.host.write(first["session_id"])
        self.host.end(first["session_id"], completed=True)
        self.host.queue("make it blue too")
        self.host.tick()
        second = self.host.build()
        self.assertIsNotNone(second)
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(second["requests"], ["make it blue too"])
        self.assertEqual(self.host.posted[-1]["body"]["session_id"], second["session_id"])
        self.assertEqual(self.host.version(), 1, "the next build starts from the published page")


class AFailedRunTest(unittest.TestCase):
    """The plan's fourth check: a failed run publishes nothing and keeps the draft."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_failed_run_publishes_nothing_and_keeps_the_draft(self) -> None:
        build = self.host.start()
        self.host.write(build["session_id"])
        self.host.end(build["session_id"], failed=True)
        self.assertEqual(self.host.version(), 0, "a failed build publishes nothing")
        self.assertEqual(self.host.newest()["phase"], builds.FAILED)
        self.assertEqual(canvases.draft(self.host.path, self.host.id), TWEAKED)

        # The next request takes the draft up where the failed build left it.
        self.host.queue("try again")
        self.host.tick()
        again = self.host.build()
        self.assertNotEqual(again["id"], build["id"], "a failed build is closed, not reopened")
        self.assertEqual(canvases.draft(self.host.path, self.host.id), TWEAKED)

    def test_an_interrupted_run_publishes_nothing(self) -> None:
        build = self.host.start()
        self.host.write(build["session_id"])
        self.host.end(build["session_id"], interrupted=True)
        self.assertEqual(self.host.version(), 0)
        self.assertEqual(self.host.newest()["phase"], builds.FAILED)


class NoReminderTest(unittest.TestCase):
    """The plan's third check: a build session gets no progress reminder at any level."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_build_session_gets_no_reminder_at_any_level(self) -> None:
        build = self.host.start()
        for level in progress.LEVELS:
            with self.subTest(level=level):
                put_setting(self.host.path, progress.LEVEL_KEY, level)
                for _index in range(progress.CALLS_BETWEEN[level] or 1):
                    progress.after_tool(
                        session_id=build["session_id"], turn_id="t", tool_name="canvas_write"
                    )
                    self.assertIsNone(
                        progress.before_tool(
                            session_id=build["session_id"], turn_id="t", tool_name="canvas_write"
                        ),
                        f"a build session is asked for no update at {level}",
                    )
        # And the canvas's own session still is: the reminder is not switched off everywhere.
        put_setting(self.host.path, progress.LEVEL_KEY, "chatty")
        for _index in range(progress.CALLS_BETWEEN["chatty"]):
            progress.after_tool(session_id=self.host.session, turn_id="t", tool_name="read_file")
        self.assertIsNotNone(
            progress.before_tool(session_id=self.host.session, turn_id="t", tool_name="read_file")
        )


class BuildSessionTest(unittest.TestCase):
    """A build's session is the canvas's to write, and no other session's."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_builds_session_writes_its_own_canvas_and_no_other(self) -> None:
        build = self.host.start()
        self.assertEqual(
            canvases.canvas_of_session(self.host.path, self.host.home, build["session_id"]),
            self.host.id,
        )
        other = canvases.create(
            self.host.path,
            request_profile="default",
            bot_id="bot-1",
            prompt="Another canvas",
            body=BODY,
        )
        # The canvas's own session is still its own, and a session that is neither a canvas's nor a
        # build's resolves to nothing at all.
        self.assertEqual(
            canvases.canvas_of_session(self.host.path, self.host.home, other["session_id"]),
            other["id"],
        )
        self.assertIsNone(canvases.canvas_of_session(self.host.path, self.host.home, "plain"))
        # A build's session is a canvas's session, so the data tools keep the canvas's own rule:
        # a name that is another canvas's is refused, and a call naming none reads this one.
        refused = json.loads(
            canvases.handle_data_read({"canvas": other["id"]}, session_id=build["session_id"])
        )
        self.assertIn("error", refused)
        self.assertIn("reaches only this canvas's data", refused["error"])
        answered = json.loads(canvases.handle_data_read({}, session_id=build["session_id"]))
        self.assertIn("documents", answered)
        # And a session that is no canvas's is still refused the document tools.
        self.assertIn(
            "error", json.loads(canvases.handle_write({"html": DOCUMENT}, session_id="plain"))
        )

    def test_a_builds_edit_starts_from_its_draft(self) -> None:
        build = self.host.start()
        self.host.write(build["session_id"])
        edited = json.loads(
            canvases.handle_edit(
                {"edits": [{"find": "Split the bill", "replace": "Split it"}]},
                session_id=build["session_id"],
            )
        )
        self.assertTrue(edited["edited"])
        self.assertEqual(canvases.draft(self.host.path, self.host.id), TWEAKED.replace(
            "Split the bill", "Split it"
        ))
        self.assertEqual(self.host.version(), 0, "an edit of a draft is no version")

    def test_a_builds_edit_of_a_canvas_with_no_draft_starts_from_the_page(self) -> None:
        canvases.write(self.host.path, self.host.id, DOCUMENT)
        build = self.host.start()
        edited = json.loads(
            canvases.handle_edit(
                {"edits": [{"find": "<h1>Tip</h1>", "replace": "<h1>Split</h1>"}]},
                session_id=build["session_id"],
            )
        )
        self.assertTrue(edited["edited"])
        self.assertEqual(
            canvases.draft(self.host.path, self.host.id), DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split</h1>")
        )
        self.assertEqual(self.host.version(), 1, "the published page is untouched")


class OneSessionPathTest(unittest.TestCase):
    """An app that predates the feature keeps the path it had: the canvas's own session."""

    def setUp(self) -> None:
        self.host = Host(self, builds_on=False)

    def test_a_canvas_made_before_builds_writes_versions_on_its_own_session(self) -> None:
        self.assertFalse(canvases.record(self.host.path, self.host.id)["builds"])
        self.host.tick()
        self.assertIsNone(self.host.build(), "no build is opened")
        self.assertEqual(self.host.posted[-1]["body"]["session_id"], self.host.session)
        self.assertNotIn("instructions", self.host.posted[-1]["body"])
        # And its writes are versions, as they always were.
        written = self.host.write(self.host.session)
        self.assertNotIn("draft", written)
        self.assertEqual(self.host.version(), 1)
        builds.ended(session_id=self.host.session, completed=True)
        self.assertEqual(self.host.version(), 1, "a canvas's own session publishes nothing at its end")


if __name__ == "__main__":
    unittest.main()
