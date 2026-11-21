"""A canvas's requests are builds: one request, one session, one version published (ADR 0170).

Run: python3 -m unittest plugin.tests.test_canvas_builds -v
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import unittest
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest import mock
from unittest.mock import patch

from plugin import PREFIX, builds, canvas_checks, canvases, chats, outbox, progress, push
from plugin.store import connect, db_path, put_setting
from plugin.tests._helpers import (
    FakeWeb,
    RouteAdapter,
    plant_runner,
    route,
    subscribed,
    take_layer_away,
    temp_hermes_home,
    wire,
)

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


class _Url:
    """A request's URL, as far as a route reads one."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.query: Dict[str, Any] = {}

    def __str__(self) -> str:
        return f"http://host{self.path}"


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

    def tick(self, session: Optional[str] = None) -> None:
        asyncio.run(outbox.tick(self.adapter, session or self.session, None, self.path))

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

    def plan(self, session: str, **plan: Any) -> Dict[str, Any]:
        """Files a build's plan, as the plan tool does, and answers what it said."""
        return json.loads(canvases.handle_plan(plan, session_id=session))

    def queued(self, session: str) -> List[str]:
        """The turns waiting in a session's queue — the canvas chat's or a build's."""
        return [item["text"] for item in outbox.read(self.path, session)["items"]]

    def ask(self, path: str, method: str = "POST") -> Dict[str, Any]:
        """One request through the plugin's own wiring, answered as the route answers it."""
        request = FakeWeb.Request()
        request.headers = {}
        request.match_info = {"canvas_id": self.id}
        request.query = {}
        request.content_length = None
        request.path = path
        request.url = _Url(path)
        return asyncio.run(route(self.app, path, method)(request))

    def live(self) -> Dict[str, Any]:
        """``runs/live`` as an app polls it: the read every screen draws whole."""
        path = f"{PREFIX}/runs/live"
        request = FakeWeb.Request()
        request.headers = {}
        request.query = {}
        request.path = path
        request.match_info = {}
        request.url = _Url(path)
        return asyncio.run(route(self.app, path, "GET")(request))["payload"]

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
        self.assertIn(self.host.build()["phase"], builds.WORKING, "the build is still open")
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


class MemoryToolTest(unittest.TestCase):
    """The plan's step 8 check: a build remembers, and the next build's seed carries it.

    The memory file itself was already read by every build's seed (step 7); what the tool adds is
    the one way a build writes it — the requirements and decisions a canvas keeps are the store's
    own file, capped and deleted with the canvas like the rest of the folder.
    """

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_second_builds_seed_holds_what_the_first_remembered(self) -> None:
        build = self.host.start()
        answered = json.loads(
            canvases.handle_memory(
                {"memory": "Split at the table."}, session_id=build["session_id"]
            )
        )
        self.assertTrue(answered["remembered"])
        self.host.end(build["session_id"], completed=True)

        self.host.queue("add a tip percentage")
        self.host.tick()
        self.assertIsNotNone(self.host.build(), "the next request opened a build")
        self.assertIn("Split at the table.", builds.seed(self.host.path, self.host.id))

    def test_the_memory_file_is_refused_past_its_cap(self) -> None:
        build = self.host.start()
        answered = json.loads(
            canvases.handle_memory(
                {"memory": "x" * (canvases.FILE_BYTES + 1)}, session_id=build["session_id"]
            )
        )
        self.assertIn("error", answered)
        self.assertIn("256 KB", answered["error"], "the refusal names the cap")

    def test_only_a_builds_session_remembers(self) -> None:
        build = self.host.start()
        # The canvas's own session writes versions, not memory, and neither does a plain one.
        for session in (self.host.session, "plain"):
            with self.subTest(session=session):
                answered = json.loads(
                    canvases.handle_memory({"memory": "Split at the table."}, session_id=session)
                )
                self.assertIn("error", answered)
        self.assertIsNone(
            canvases.draft(self.host.path, self.host.id), "the refused calls wrote nothing"
        )
        memory = canvases.folder_of(self.host.home, self.host.id) / canvases.MEMORY
        self.assertFalse(memory.exists(), "no memory file is made by a refused call")


class PlanWaitingTest(unittest.TestCase):
    """The plan's step 9 checks: a build plans first, a waiting plan is revised by a message and
    built on Approve, a draft write before a plan is refused, and Stop publishes nothing.

    The plan tool is the one way a build opens its draft: what will change, the checks it will be
    run against, and whether it waits for the reader's Approve (G6). While one waits the build
    holds open — a message revises it and Approve builds it — and a stop ends it with nothing
    published.
    """

    def setUp(self) -> None:
        self.host = Host(self)

    def file(self, session: str, **plan: Any) -> Dict[str, Any]:
        return self.host.plan(session, **plan)

    def test_a_plan_that_waits_is_revised_by_a_message_and_built_on_approve(self) -> None:
        build = self.host.start()
        filed = self.file(
            build["session_id"], changes="The heading says Split the bill.", checks=[], wait=True
        )
        self.assertTrue(filed["planned"])
        self.assertTrue(filed["wait"])

        # The run's end holds the build open: a plan that waits publishes nothing.
        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.version(), 0, "a waiting plan publishes nothing")
        self.assertEqual(self.host.build()["phase"], builds.WAITING, "the build waits")

        # A message while it waits is posted as the build's next turn, and the plan is revised.
        self.host.adapter.run("run_1", build["session_id"], "completed", 3)
        self.host.queue("and make it blue too")
        self.host.tick()
        self.assertEqual(self.host.posted[-1]["body"]["session_id"], build["session_id"])
        revised = self.file(
            build["session_id"],
            changes="The heading says Split the bill, and the page is blue.",
            checks=[],
            wait=True,
        )
        self.assertTrue(revised["wait"])
        self.host.adapter.run("run_2", build["session_id"], "completed", 4)
        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.version(), 0, "still waiting")

        # Approve clears the wait and queues the approval turn on the build's own session.
        answered = self.host.ask(f"{PREFIX}/canvases/{{canvas_id}}/build/approve")["payload"]
        self.assertFalse(answered["build"]["wait"], "the draft opens on Approve")
        self.host.tick(build["session_id"])
        self.assertEqual(self.host.posted[-1]["body"]["session_id"], build["session_id"])
        self.assertEqual(
            self.host.build()["requests"],
            [PROMPT, "and make it blue too"],
            "the approval turn is not a request the build took",
        )

        # The draft opens, and the run's end publishes one version carrying both requests.
        written = self.host.write(build["session_id"])
        self.assertTrue(written["written"])
        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.version(), 1)
        self.assertEqual(self.host.record()["requests"], [PROMPT, "and make it blue too"])

    def test_a_plan_that_does_not_wait_builds_straight_away(self) -> None:
        build = self.host.start()
        filed = self.file(
            build["session_id"], changes="The heading says Split the bill.", checks=[], wait=False
        )
        self.assertFalse(filed["wait"])
        self.assertIsNone(
            canvases.before_tool(tool_name="canvas_write", session_id=build["session_id"]),
            "a plan that does not wait leaves the draft open",
        )
        written = self.host.write(build["session_id"])
        self.assertTrue(written["written"])
        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.version(), 1)

    def test_a_draft_write_before_a_plan_is_refused(self) -> None:
        build = self.host.start()
        blocked = canvases.before_tool(tool_name="canvas_write", session_id=build["session_id"])
        self.assertIsNotNone(blocked, "nothing reaches the draft before a plan is filed")
        self.assertEqual(blocked["action"], "block")
        self.assertIn("canvas_plan", blocked["message"])
        self.assertIsNotNone(
            canvases.before_tool(tool_name="canvas_edit", session_id=build["session_id"]),
            "an edit is a draft write too",
        )
        self.assertIsNone(canvases.draft(self.host.path, self.host.id))

        # Filing the plan opens the draft, and a plan that waits closes it again until Approve.
        self.file(build["session_id"], changes="A tweak.", checks=[], wait=False)
        self.assertIsNone(
            canvases.before_tool(tool_name="canvas_write", session_id=build["session_id"])
        )
        self.file(build["session_id"], changes="A structural change.", checks=[], wait=True)
        waiting = canvases.before_tool(tool_name="canvas_write", session_id=build["session_id"])
        self.assertIsNotNone(waiting, "a plan that waits holds the draft closed")
        self.assertIn("Approve", waiting["message"])

        # The canvas's own session is not a build's: it writes versions as it always did.
        self.assertIsNone(canvases.before_tool(tool_name="canvas_write", session_id=self.host.session))

    def test_stop_publishes_nothing(self) -> None:
        build = self.host.start()
        self.file(build["session_id"], changes="A structural change.", checks=[], wait=True)
        answered = self.host.ask(f"{PREFIX}/canvases/{{canvas_id}}/build/stop")["payload"]
        self.assertEqual(answered["build"]["phase"], builds.STOPPED)
        self.assertEqual(self.host.version(), 0, "stop publishes nothing")
        self.assertIsNone(self.host.build(), "the build is closed")

        # The run that was waiting ends after the stop, and still publishes nothing.
        self.host.end(build["session_id"], completed=True)
        self.assertEqual(self.host.version(), 0)
        self.assertEqual(self.host.newest()["phase"], builds.STOPPED)

    def test_the_seed_names_the_plan_tool(self) -> None:
        seeded = builds.seed(self.host.path, self.host.id)
        self.assertIn("canvas_plan", seeded, "a build is told to plan before it writes")


def passing_answer(request: Dict[str, Any]) -> Dict[str, Any]:
    """What the harness page answers for a draft that passes every test."""
    return {
        "tests": [{"name": one["name"], "ok": True, "error": None} for one in request["tests"]],
        "console": [],
    }


def failing_answer(request: Dict[str, Any]) -> Dict[str, Any]:
    """What the harness page answers for a draft that breaks every test."""
    return {
        "tests": [
            {"name": one["name"], "ok": False, "error": "still the old heading"}
            for one in request["tests"]
        ],
        "console": ["error: the page said something"],
    }


def plant_no_vision() -> patch:
    """Hermes's model catalogue, answering that a model reads no images."""
    module = ModuleType("agent.models_dev")
    module.get_model_capabilities = lambda provider, model, allow_network=False: SimpleNamespace(
        supports_vision=False
    )
    agent = ModuleType("agent")
    agent.models_dev = module
    return patch.dict(sys.modules, {"agent": agent, "agent.models_dev": module})


class CheckedBeforePublishTest(unittest.TestCase):
    """The plan's step 10 checks: a build is checked on its rendered page before it publishes.

    The browser's own side is the one thing a test host cannot run, so the runner is planted: what
    is proved is the loop — a draft changed since its last check is checked, its report is the
    build's next turn, and the version publishes with what the checks said of it (passing, failing,
    or unchecked where no browser could draw the page).
    """

    def setUp(self) -> None:
        self.host = Host(self)

    def build(self, checks: Optional[List[Dict[str, str]]] = None, document: str = DOCUMENT) -> Dict[str, Any]:
        """A build with a plan filed and the page written, before its first run ends."""
        found = self.host.start()
        self.host.plan(
            found["session_id"],
            changes="The heading says Split the bill.",
            checks=checks or [],
            wait=False,
        )
        self.host.write(found["session_id"], document)
        return found

    def test_a_small_tweak_builds_checks_and_publishes_one_version(self) -> None:
        planted = plant_runner(passing_answer)
        self.addCleanup(planted.stop)
        with planted:
            build = self.build(checks=[{"name": "the heading is split", "script": "return 1"}])
            session = build["session_id"]
            self.host.adapter.run("run_1", session, "completed", 3)
            self.host.end(session, completed=True)

            # The draft changed, so the check ran before anything was published: one report turn
            # is queued on the build's own session, and the version waits on the turn it starts.
            self.assertEqual(self.host.version(), 0, "a checked build publishes nothing yet")
            self.assertEqual(self.host.newest()["rounds"], 1)
            self.assertEqual(len(self.host.queued(session)), 1)
            self.assertIn("the heading is split", self.host.queued(session)[0])

            # The report is the words and the four screenshots, inline as image parts.
            self.host.tick(session)
            run = self.host.posted[-1]["body"]
            self.assertEqual(run["session_id"], session)
            parts = run["input"][0]["content"]
            self.assertEqual(
                [one["type"] for one in parts],
                ["text", "image_url", "image_url", "image_url", "image_url"],
                "the four drawings ride the report as inline images",
            )
            self.assertTrue(
                all(one["image_url"]["url"].startswith("data:image/png;base64,") for one in parts[1:])
            )

            # The turn that ends on the same draft changes nothing, so the loop ends and the one
            # version publishes with what the check said of it.
            self.host.adapter.run("run_2", session, "completed", 4)
            self.host.end(session, completed=True)
            self.assertEqual(self.host.version(), 1, "one build, one version")
            self.assertEqual(self.host.record()["flag"], canvas_checks.PASSING)
            self.assertEqual(self.host.record()["requests"], [PROMPT])
            self.assertEqual(self.host.record()["summary"], SUMMARY)

    def test_a_build_whose_checks_keep_failing_publishes_flagged_failing(self) -> None:
        planted = plant_runner(failing_answer)
        self.addCleanup(planted.stop)
        fixed = [
            DOCUMENT,
            TWEAKED,
            DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split it</h1>"),
            DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split the bill</h1>"),
        ]
        with planted:
            build = self.build(
                checks=[{"name": "the heading is split", "script": "throw new Error('old heading')"}],
                document=fixed[0],
            )
            session = build["session_id"]
            # Three rounds: each report posts, the agent tries again, and the check still fails.
            for number in range(1, 4):
                self.host.adapter.run(f"run_{number}", session, "completed", 10 + number)
                self.host.end(session, completed=True)
                self.assertEqual(self.host.version(), 0, "still failing, so still nothing published")
                self.assertEqual(self.host.newest()["rounds"], number)
                self.assertEqual(len(self.host.queued(session)), 1, "one report turn per round")
                self.assertIn("failed", self.host.queued(session)[0])
                self.host.tick(session)
                self.assertEqual(self.host.posted[-1]["body"]["session_id"], session)
                self.host.write(session, fixed[number])
            # The round cap reached with the draft still changing: the build publishes what it
            # has, flagged failing — a build never stalls on its checks.
            self.host.adapter.run("run_4", session, "completed", 20)
            self.host.end(session, completed=True)
            self.assertEqual(self.host.version(), 1)
            self.assertEqual(self.host.record()["flag"], canvas_checks.FAILING)
            self.assertEqual(self.host.newest()["rounds"], 3)

    def test_a_build_on_a_host_with_no_browser_publishes_unchecked(self) -> None:
        with take_layer_away():
            build = self.build(checks=[{"name": "the heading is split", "script": "return 1"}])
            session = build["session_id"]
            self.host.adapter.run("run_1", session, "completed", 3)
            self.host.end(session, completed=True)
            # No browser drew the page, so there is no report to post and no second round: the
            # build publishes the draft marked unchecked.
            self.assertEqual(self.host.version(), 1)
            self.assertEqual(self.host.record()["flag"], canvas_checks.UNCHECKED)
            self.assertEqual(self.host.queued(session), [])
            self.assertEqual(self.host.newest()["rounds"], 1)
            self.assertEqual(len(self.host.posted), 1, "no report turn was posted")

    def test_a_model_that_takes_no_images_is_given_the_screenshots_as_paths(self) -> None:
        chats.set_choice(self.host.path, self.host.canvas["chat_id"], {"provider": "p", "model": "m"})
        planted = plant_runner(passing_answer)
        self.addCleanup(planted.stop)
        with planted, plant_no_vision():
            build = self.build(checks=[{"name": "the heading is split", "script": "return 1"}])
            session = build["session_id"]
            self.host.adapter.run("run_1", session, "completed", 3)
            self.host.end(session, completed=True)
            self.host.tick(session)
            run = self.host.posted[-1]["body"]
            content = run["input"][0]["content"]
            self.assertIsInstance(content, str, "a model that reads no images is given paths")
            self.assertEqual(
                (run["provider"], run["model"]), ("p", "m"), "the report runs on the canvas's pin"
            )
            for width, mode in ((390, "light"), (390, "dark"), (768, "light"), (768, "dark")):
                self.assertIn(f"{width}-{mode}.png", content)


class WhereABuildIsTest(unittest.TestCase):
    """The plan's step 13 check, on the host's side: a build says what it is doing now.

    The lane draws builds rather than the transcript, so the record has to carry the phase it is in
    and a line saying what is happening, and a canvas's read has to hand back the builds it has
    finished — each with the request, the summary, the check flag and the version it published.
    """

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_build_moves_from_planning_to_waiting_to_building(self) -> None:
        build = self.host.start()
        self.assertEqual(build["phase"], builds.PLANNING)
        self.assertEqual(build["activity"], builds.ACTIVITY[builds.PLANNING])

        self.host.plan(
            build["session_id"],
            changes="The heading says Split the bill.",
            checks=[],
            wait=True,
        )
        waiting = self.host.build()
        self.assertEqual(waiting["phase"], builds.WAITING)
        self.assertEqual(waiting["activity"], builds.ACTIVITY[builds.WAITING])

        self.host.ask(f"{PREFIX}/canvases/{{canvas_id}}/build/approve")
        building = self.host.build()
        self.assertEqual(building["phase"], builds.BUILDING)
        self.assertEqual(building["activity"], builds.ACTIVITY[builds.BUILDING])

    def test_a_clear_plan_builds_straight_away(self) -> None:
        build = self.host.start()
        self.host.plan(
            build["session_id"], changes="The heading says Split the bill.", checks=[], wait=False
        )
        self.assertEqual(self.host.build()["phase"], builds.BUILDING)

    def test_a_build_says_checking_and_publishing_as_it_does_them(self) -> None:
        planted = plant_runner(passing_answer)
        self.addCleanup(planted.stop)
        seen: List[str] = []
        writing = canvases.write
        with planted:

            def watched(*args: Any, **kwargs: Any) -> Any:
                found = builds.of_canvas(self.host.path, self.host.id) or {}
                seen.append(str(found.get("phase")))
                return writing(*args, **kwargs)

            build = self.host.start()
            session = build["session_id"]
            self.host.plan(
                session,
                changes="The heading says Split the bill.",
                checks=[{"name": "the heading is split", "script": "return 1"}],
                wait=False,
            )
            self.host.write(session, TWEAKED)
            self.host.adapter.run("run_1", session, "completed", 3)
            with patch.object(canvases, "write", watched):
                self.host.end(session, completed=True)
            self.assertEqual(
                self.host.newest()["phase"], builds.CHECKING, "the build is checking, not published"
            )
            self.assertEqual(self.host.newest()["activity"], builds.ACTIVITY[builds.CHECKING])

            # The turn that changes nothing ends the loop: the version is written while the build
            # says it is publishing, and the record then says it published.
            self.host.tick(session)
            self.host.adapter.run("run_2", session, "completed", 4)
            with patch.object(canvases, "write", watched):
                self.host.end(session, completed=True)
        self.assertEqual(seen, [builds.PUBLISHING], "the record says publishing as it publishes")
        published = self.host.newest()
        self.assertEqual(published["phase"], builds.PUBLISHED)
        self.assertEqual(published["version"], 1)

    def test_the_list_carries_the_build_a_canvas_is_working_in(self) -> None:
        # A phone's edit screen draws the record and never the document, so the list read is the one
        # that has to carry where the build is — otherwise its lane has nothing to say while it works.
        build = self.host.start()
        answer = self.host.ask(f"{PREFIX}/canvases", "GET")["payload"]
        row = next(one for one in answer["canvases"] if one["id"] == self.host.id)
        self.assertTrue(row["builds"])
        self.assertEqual(row["build"]["phase"], builds.PLANNING)
        self.assertEqual(row["build"]["activity"], builds.ACTIVITY[builds.PLANNING])
        self.assertEqual(row["build"]["session"], build["session_id"])

    def test_the_builds_read_answers_every_build_newest_first(self) -> None:
        build = self.host.start()
        session = build["session_id"]
        self.host.plan(session, changes="The heading says Split the bill.", checks=[], wait=False)
        self.host.write(session, TWEAKED)
        self.host.adapter.run("run_1", session, "completed", 3)
        self.host.end(session, completed=True)

        answer = self.host.ask(f"{PREFIX}/canvases/{{canvas_id}}/builds", "GET")["payload"]
        self.assertEqual(answer["object"], "gots.canvas.builds")
        self.assertEqual(len(answer["builds"]), 1)
        one = answer["builds"][0]
        self.assertEqual(one["session"], session)
        self.assertEqual(one["phase"], builds.PUBLISHED)
        self.assertEqual(one["requests"], [PROMPT])
        self.assertEqual(one["summary"], SUMMARY)
        self.assertEqual(one["version"], 1)
        self.assertEqual(one["flag"], canvas_checks.UNCHECKED)
        self.assertIsNone(one["activity"], "a finished build has nothing going on")

    def test_a_build_records_a_step_per_phase_it_visits(self) -> None:
        planted = plant_runner(passing_answer)
        self.addCleanup(planted.stop)
        with planted:
            build = self.host.start()
            session = build["session_id"]
            self.host.plan(
                session,
                changes="The heading says Split the bill.",
                checks=[{"name": "the heading is split", "script": "return 1"}],
                wait=False,
            )
            self.host.write(session, TWEAKED)
            self.host.adapter.run("run_1", session, "completed", 3)
            self.host.end(session, completed=True)

            # The first check ran and its report is the build's next turn: the build writes again
            # and its next end checks the page once more.
            self.host.tick(session)
            self.host.adapter.run("run_2", session, "completed", 4)
            self.host.write(session, DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split it</h1>"))

        # The second check cannot run on a host with no browser, so the build publishes what its
        # last round said while the checking visit it opened is still the open one.
        with take_layer_away():
            self.host.adapter.run("run_3", session, "completed", 5)
            self.host.end(session, completed=True)

        answer = self.host.ask(f"{PREFIX}/canvases/{{canvas_id}}/builds", "GET")["payload"]
        published = next(one for one in answer["builds"] if one["id"] == build["id"])
        steps = published.get("steps") or []
        self.assertEqual(
            [one["phase"] for one in steps],
            ["planning", "building", "checking", "building", "checking", "publishing"],
        )
        # Windows tile: a visit ends where the next begins, and the build's end closes the last.
        for before, after in zip(steps, steps[1:]):
            self.assertEqual(before["end"], after["start"], "a step ends where the next begins")
        self.assertIn("end", steps[-1], "a finished build has no open step")
        # Only a checking visit carries a flag, and the last one's is the version's.
        self.assertEqual([one["phase"] for one in steps if "flag" in one], ["checking", "checking"])
        self.assertEqual(steps[2]["flag"], canvas_checks.PASSING, "the round that passed said so")
        self.assertEqual(steps[-2]["flag"], published["flag"])
        self.assertEqual(steps[-2]["flag"], canvas_checks.UNCHECKED)

        # A build the record predates has no rows, so it answers no steps at all — never an empty
        # list, which would say it visited nothing (I6).
        conn = connect(self.host.path)
        try:
            conn.execute(
                "INSERT INTO canvas_builds (id, canvas_id, session_id, phase, requests, summary,"
                " run_id, at, created_at) VALUES ('old', ?, 'canvas-old', 'published', ?, NULL,"
                " NULL, 1, 1)",
                (self.host.id, json.dumps(["an older request"])),
            )
        finally:
            conn.close()
        rows = self.host.ask(f"{PREFIX}/canvases/{{canvas_id}}/builds", "GET")["payload"]["builds"]
        older = next(one for one in rows if one["id"] == "old")
        self.assertNotIn("steps", older)


class ClosedAppTest(unittest.TestCase):
    """The plan's step 12 check: a waiting build pushes as a plan, and a published build pushes once.

    The app is closed, so the news has to reach it: a build that waits on its plan reports the
    canvas chat as waiting with kind ``plan`` — the read every screen polls, and the existing plan
    push — and a published build sends one run-finished push carrying the summary's first line.
    Both are about the canvas chat's session, so its mute and the bot's silence them, and a tap
    opens the canvas through the chat the notice names.
    """

    def setUp(self) -> None:
        self.host = Host(self)
        subscribed(self.host.path, '["code_input", "chat_run_done"]')
        self.sent: List[Dict[str, Any]] = []
        self.arrived = threading.Event()

        def deliver(path: Any, kind: str, category: str, session_id: str, notice: Any) -> None:
            self.sent.append(
                {"kind": kind, "category": category, "session": session_id, "notice": notice}
            )
            self.arrived.set()

        delivering = mock.patch.object(push, "_deliver", deliver)
        delivering.start()
        self.addCleanup(delivering.stop)

    def pushes(self) -> List[Dict[str, Any]]:
        """The pushes that reached a transport since the last read, as they land."""
        self.arrived.wait(1)
        found, self.sent[:] = list(self.sent), []
        self.arrived.clear()
        return found

    def test_a_waiting_build_pushes_as_a_plan_and_a_published_build_pushes_once(self) -> None:
        build = self.host.start()
        session = build["session_id"]
        self.host.plan(session, changes="The heading says Split the bill.", checks=[], wait=True)

        # The run ends with the plan waiting: the build holds open, and the canvas chat hears it
        # once — as a plan waiting, the same news a project session's plan sends.
        self.host.adapter.run("run_1", session, "completed", 2)
        self.host.end(session, completed=True)
        pushes = self.pushes()
        self.assertEqual([one["kind"] for one in pushes], ["plan"])
        self.assertEqual(pushes[0]["session"], self.host.session, "the canvas chat's news")
        self.assertEqual(pushes[0]["notice"].conversation.get("chat"), self.host.canvas["chat_id"])
        # And the read every screen polls says the same, in the words the app already draws.
        self.assertEqual(builds.waiting(self.host.path), {self.host.session: {"kind": "plan"}})
        self.assertEqual(self.host.live()["waiting"][self.host.session], {"kind": "plan"})

        # A message revises the plan and it waits still: one wait, one push.
        self.host.queue("and make it blue too")
        self.host.tick()
        self.host.plan(
            session,
            changes="The heading says Split the bill, and the page is blue.",
            checks=[],
            wait=True,
        )
        self.host.adapter.run("run_2", session, "completed", 3)
        self.host.end(session, completed=True)
        self.assertEqual(self.pushes(), [], "a revised plan is the same wait")

        # Approve builds it: the draft is written, the run ends, and the build publishes once.
        self.host.ask(f"{PREFIX}/canvases/{{canvas_id}}/build/approve")
        self.host.tick(session)
        self.host.write(session)
        self.host.adapter.run("run_3", session, "completed", 4)
        self.host.end(session, completed=True)
        self.assertEqual(self.host.version(), 1)
        pushes = self.pushes()
        self.assertEqual([one["kind"] for one in pushes], ["run_done"], "one push for one build")
        self.assertEqual(pushes[0]["session"], self.host.session)
        self.assertEqual(pushes[0]["notice"].get("body"), SUMMARY, "the summary's first line")

        # Both are the canvas chat's news, so its mute silences them.
        record = chats.read(self.host.path)[self.host.canvas["chat_id"]]["value"]
        chats.merge(
            self.host.path,
            {
                self.host.canvas["chat_id"]: {
                    "at": record["updatedAt"] + 1,
                    "value": {**record, "muted": True},
                }
            },
        )
        for kind in ("plan", "run_done"):
            self.assertTrue(
                push.muted(self.host.path, kind, self.host.session), f"{kind} obeys the chat's mute"
            )


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
