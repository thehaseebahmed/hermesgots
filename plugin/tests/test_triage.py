"""Triage: a Main message stays, continues a thread or opens a new one, and every failure is Main.

Run: python3 -m unittest plugin.tests.test_triage -v
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from plugin import chats, outbox, triage
from plugin.store import db_path
from plugin.tests._host import Result, hermes

MAIN = "main-bot"


def chat(**value):
    base = {"profileId": "bot", "title": "A chat", "createdAt": 1, "updatedAt": 1}
    return {"at": 1, "value": {**base, **value}}


class Llm:
    def __init__(self, parsed=None, error=None):
        self.parsed, self.error, self.calls = parsed, error, []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(parsed=self.parsed)


class TriageTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.path = db_path(self.home)
        self.records = {
            MAIN: chat(main=True, hermesSessionId="memento-main-bot", title="Main"),
            "t1": chat(hermesSessionId="s1", title="Trip to Lisbon", updatedAt=5),
            "t2": chat(hermesSessionId="s2", title="Taxes", updatedAt=9),
        }
        chats.merge(self.path, self.records)

    def run_triage(self, llm, text="more on Lisbon", session="memento-main-bot"):
        with mock.patch.object(triage, "_llm", return_value=llm), mock.patch.object(
            triage, "_rows", return_value={}
        ):
            return triage.triage(self.path, self.home, session, text)

    def test_stay_is_main(self):
        self.assertEqual(self.run_triage(Llm({"decision": "stay"})), {"decision": "main"})

    def test_continue_names_the_thread_and_its_session(self):
        found = self.run_triage(Llm({"decision": "continue", "thread": "t1"}))
        self.assertEqual(found["decision"], "thread")
        self.assertEqual((found["thread"], found["session_id"]), ("t1", "s1"))

    def test_every_failure_is_main(self):
        for llm in (
            Llm({"decision": "continue", "thread": "nope"}),
            Llm({"decision": "continue"}),
            Llm({"decision": "maybe"}),
            Llm("garbage"),
            Llm(None),
            Llm(error=RuntimeError("down")),
            None,
        ):
            self.assertEqual(self.run_triage(llm), {"decision": "main"})

    def test_only_a_main_session_is_triaged(self):
        llm = Llm({"decision": "continue", "thread": "t1"})
        self.assertEqual(self.run_triage(llm, session="s2"), {"decision": "main"})
        self.assertEqual(llm.calls, [])

    def test_no_threads_still_lets_a_message_open_one(self):
        chats.merge(self.path, {k: {"at": 2, "deleted": True} for k in ("t1", "t2")})
        llm = Llm({"decision": "continue", "thread": "t1"})
        self.assertEqual(self.run_triage(llm), {"decision": "main"})
        self.assertEqual(len(llm.calls), 1)

    def test_no_threads_a_message_can_open_one(self):
        chats.merge(self.path, {k: {"at": 2, "deleted": True} for k in ("t1", "t2")})
        self.assertEqual(self.run_triage(Llm({"decision": "new"}))["decision"], "new")

    def test_new_asks_for_a_thread_and_makes_nothing_yet(self):
        found = self.run_triage(Llm({"decision": "new"}))
        self.assertEqual(found["decision"], "new")
        self.assertEqual(found, {"decision": "new", "profile_id": "bot"})
        self.assertEqual(set(chats.read(self.path)), {MAIN, "t1", "t2"})

    def test_open_thread_writes_the_record_a_new_chat_has(self):
        chat_id, session = triage.open_thread(self.path, "bot")
        self.assertEqual(session, f"memento-{chat_id}")
        record = chats.read(self.path)[chat_id]
        self.assertEqual(record["at"], record["value"]["changedAt"])
        value = record["value"]
        self.assertEqual(
            (value["profileId"], value["title"], value["hermesSessionId"], value["createdAt"] == value["updatedAt"]),
            ("bot", "New chat", session, False),
        )
        self.assertGreater(value["updatedAt"], value["createdAt"])
        self.assertNotIn("main", value)
        self.assertNotIn("projectId", value)

    def test_a_new_thread_is_started_with_only_the_message_and_its_files(self):
        body = {
            "model": "m",
            "provider": "p",
            "instructions": "i",
            "session_id": "memento-main-bot",
            "input": [{"role": "user", "content": "plan my trip"}],
            "conversation_history": [{"role": "user", "content": "old"}],
        }
        files = [{"name": "a.pdf", "type": "application/pdf", "size": 3, "path": "/h/a.pdf"}]
        started = triage.start_thread(
            self.path, "bot", "bot", "plan my trip", files, body
        )
        self.assertEqual(started["session_id"], f"memento-{started['thread']}")
        self.assertEqual(chats.read(self.path)[started["thread"]]["value"]["hermesSessionId"], started["session_id"])
        queued = outbox.read(self.path, started["session_id"])["items"]
        self.assertEqual([item["id"] for item in queued], [started["item"]["id"]])
        self.assertEqual(queued[0]["attachments"], files)
        row, _ = outbox.head(self.path, started["session_id"])
        run = json.loads(row["body"])
        self.assertEqual(run["session_id"], started["session_id"])
        self.assertEqual(run["input"], body["input"])
        self.assertNotIn("conversation_history", run)
        self.assertEqual(outbox.read(self.path, "memento-main-bot")["items"], [])

    def test_a_new_thread_says_which_model_its_first_turn_runs_on(self):
        body = {"model": "m", "provider": "p", "input": [{"role": "user", "content": "hi"}]}
        started = triage.start_thread(self.path, "bot", "bot", "hi", [], body)
        value = chats.read(self.path)[started["thread"]]["value"]
        self.assertEqual(value["modelChoice"], {"provider": "p", "model": "m"})
        plain = triage.start_thread(
            self.path, "bot", "bot", "hi", [], {"input": [{"role": "user", "content": "hi"}]}
        )
        self.assertNotIn("modelChoice", chats.read(self.path)[plain["thread"]]["value"])

    def test_a_repeated_ask_waits_for_the_first(self):
        import asyncio

        order = []

        async def ask(name, hold):
            async with triage.lock("s:1"):
                order.append(f"{name} in")
                await asyncio.sleep(hold)
                order.append(f"{name} out")

        async def both():
            await asyncio.gather(ask("a", 0.05), ask("b", 0))

        asyncio.run(both())
        self.assertEqual(order, ["a in", "a out", "b in", "b out"])
        self.assertEqual(triage._locks, {})

    def test_a_thread_that_cant_be_started_leaves_no_record(self):
        before = set(chats.read(self.path))
        with self.assertRaises(ValueError):
            triage.start_thread(self.path, "bot", "bot", "hi", [], {"input": []})
        after = chats.read(self.path)
        self.assertEqual({k for k, v in after.items() if not v.get("deleted")}, before)

    def test_discard_leaves_a_tombstone(self):
        chat_id, _ = triage.open_thread(self.path, "bot")
        triage.discard(self.path, chat_id)
        self.assertTrue(chats.read(self.path)[chat_id].get("deleted"))


class CandidateTests(unittest.TestCase):
    def pick(self, records):
        with mock.patch.object(triage, "_rows", return_value={}):
            return triage.candidates(records, MAIN, Path("."))

    def test_plain_threads_only(self):
        found = self.pick(
            {
                MAIN: chat(main=True, hermesSessionId="m"),
                "ok": chat(hermesSessionId="a"),
                "session": chat(hermesSessionId="b", projectId="p"),
                "discarded": chat(hermesSessionId="c", discardedAt=3),
                "resolved": chat(hermesSessionId="d", resolvedAt=3),
                "gone": {"at": 2, "deleted": True},
                "other-bot": chat(hermesSessionId="e", profileId="other"),
                "other-main": chat(hermesSessionId="f", main=True),
            }
        )
        self.assertEqual([c["id"] for c in found], ["ok"])

    def test_capped_at_fifteen_most_recent(self):
        records = {MAIN: chat(main=True, hermesSessionId="m")}
        for n in range(20):
            records[f"t{n}"] = chat(hermesSessionId=f"s{n}", updatedAt=n)
        found = self.pick(records)
        self.assertEqual(len(found), triage.MAX_CANDIDATES)
        self.assertEqual(found[0]["id"], "t19")
        self.assertEqual(found[-1]["id"], "t5")

    def test_carries_title_last_line_and_activity(self):
        records = {MAIN: chat(main=True), "t": chat(hermesSessionId="s", title="Lisbon", updatedAt=7)}
        with mock.patch.object(
            triage, "_rows", return_value={"s": [{"role": "user", "text": "hi\nthere"}]}
        ):
            found = triage.candidates(records, MAIN, Path("."))
        self.assertEqual(found, [{"id": "t", "title": "Lisbon", "last": "hi there", "active": 7}])


class RowsTests(unittest.TestCase):
    def test_one_connection_reads_every_session_and_follows_compression(self):
        import sqlite3

        home = Path(tempfile.mkdtemp())
        conn = sqlite3.connect(home / "state.db")
        conn.execute("CREATE TABLE sessions (id TEXT, parent_session_id TEXT)")
        conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT)")
        conn.execute("INSERT INTO sessions VALUES ('child', 'a')")
        conn.executemany(
            "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
            [("a", "user", "old"), ("child", "assistant", "newest"), ("b", "user", "other")],
        )
        conn.commit()
        conn.close()
        found = triage._rows(home, ["a", "b", "none"], 1)
        self.assertEqual(found["a"], [{"role": "assistant", "text": "newest"}])
        self.assertEqual(found["b"], [{"role": "user", "text": "other"}])
        self.assertEqual(found["none"], [])

    def test_a_past_deadline_asks_no_model(self):
        llm = Llm({"decision": "continue", "thread": "t"})
        with mock.patch.object(triage, "_llm", return_value=llm):
            self.assertIsNone(triage.decide("hi", [{"id": "t", "title": "", "last": "", "active": 1}], [], 0.0))
        self.assertEqual(llm.calls, [])

    def test_an_answer_is_given_once_per_id(self):
        triage.remember("s:1", {"decision": "main"})
        self.assertEqual(triage.given("s:1"), {"decision": "main"})
        self.assertIsNone(triage.given("s:2"))
        self.assertIsNone(triage.given(None))


class TriageModelTests(unittest.TestCase):
    config_path = Path("/home/h/config.yaml")
    allowed = {"model": True, "provider": True}

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.path = db_path(self.home)
        chats.merge(
            self.path,
            {
                MAIN: chat(main=True, hermesSessionId="memento-main-bot", title="Main"),
                "t1": chat(hermesSessionId="s1", title="Trip", updatedAt=5),
            },
        )

    def set(self, pick, gate=None, results=()):
        patch, calls, _ = hermes({"model": {"default": "own", "provider": "openrouter"}}, results)
        with patch:
            return triage.set_model(self.config_path, self.path, pick, gate or self.allowed), calls

    def test_unset_reads_as_none(self):
        self.assertIsNone(triage.read_model(self.path))
        self.assertIsNone(triage.read_model(self.home / "missing.db"))

    def test_a_pick_is_written_and_read_back_as_hermes_resolved_it(self):
        saved, calls = self.set(
            {"provider": "anthropic", "model": "haiku"}, results=[Result(True, "claude-haiku", "anthropic")]
        )
        self.assertEqual(saved, {"provider": "anthropic", "model": "claude-haiku"})
        self.assertEqual(triage.read_model(self.path), saved)
        self.assertEqual(calls["switch"][0]["raw_input"], "haiku")
        # Nothing goes into Hermes's config: the pick is the bot's triage setting alone.
        self.assertEqual(calls["write"], [])

    def test_clearing_falls_back_to_the_bots_own_model(self):
        self.set({"provider": "a", "model": "b"})
        saved, _ = self.set(None)
        self.assertIsNone(saved)
        self.assertIsNone(triage.read_model(self.path))
        self.assertEqual(self.set(None)[0], None)

    def test_a_refused_pick_writes_nothing(self):
        self.set({"provider": "a", "model": "b"})
        with self.assertRaisesRegex(ValueError, "Unknown provider"):
            self.set({"provider": "nope", "model": "c"}, results=[Result(False, error="Unknown provider 'nope'.")])
        self.assertEqual(triage.read_model(self.path), {"provider": "a", "model": "b"})

    def test_a_pick_needs_the_hosts_override_permission(self):
        for gate in ({"model": False, "provider": False}, {"model": True, "provider": False}):
            with self.assertRaises(triage.Withheld):
                self.set({"provider": "a", "model": "b"}, gate=gate)
        self.assertIsNone(triage.read_model(self.path))
        # Clearing needs none: it asks nothing of the host.
        self.assertIsNone(self.set(None, gate={"model": False, "provider": False})[0])

    def test_a_pick_already_held_is_not_checked_again(self):
        self.set({"provider": "a", "model": "b"})
        _, calls = self.set({"provider": "a", "model": "b"})
        self.assertEqual(calls["switch"], [])

    def test_triage_decides_with_the_picked_model(self):
        self.set({"provider": "a", "model": "b"})
        llm = Llm({"decision": "stay"})
        with mock.patch.object(triage, "_llm", return_value=llm), mock.patch.object(
            triage, "_rows", return_value={}
        ):
            triage.triage(self.path, self.home, "memento-main-bot", "hi")
        self.assertEqual((llm.calls[0]["provider"], llm.calls[0]["model"]), ("a", "b"))

    def test_triage_without_a_pick_uses_the_bots_own_model(self):
        llm = Llm({"decision": "stay"})
        with mock.patch.object(triage, "_llm", return_value=llm), mock.patch.object(
            triage, "_rows", return_value={}
        ):
            triage.triage(self.path, self.home, "memento-main-bot", "hi")
        self.assertNotIn("model", llm.calls[0])
        self.assertNotIn("provider", llm.calls[0])

    def test_a_pick_the_host_no_longer_allows_falls_back_to_the_bots_own(self):
        class Denied(Exception):
            pass

        class Llm2(Llm):
            def complete_structured(self, **kwargs):
                self.calls.append(kwargs)
                if "model" in kwargs:
                    raise Denied("override denied")
                return SimpleNamespace(parsed={"decision": "new"})

        llm = Llm2()
        with mock.patch.object(triage, "_llm", return_value=llm):
            decided = triage.decide("hi", [], [], None, {"provider": "a", "model": "b"})
        self.assertEqual(decided, triage.NEW)
        self.assertEqual(len(llm.calls), 2)

    def test_a_pick_that_stopped_working_falls_back_to_the_bots_own(self):
        class Llm3(Llm):
            def complete_structured(self, **kwargs):
                self.calls.append(kwargs)
                if "model" in kwargs:
                    raise RuntimeError("model retired")
                return SimpleNamespace(parsed={"decision": "stay"})

        llm = Llm3()
        with mock.patch.object(triage, "_llm", return_value=llm):
            self.assertIsNone(triage.decide("hi", [], [], None, {"provider": "a", "model": "b"}))
        self.assertEqual(len(llm.calls), 2)
        self.assertNotIn("model", llm.calls[1])

    def test_saving_a_held_pick_again_is_a_no_op_even_once_the_override_is_withheld(self):
        self.set(
            {"provider": "anthropic", "model": "haiku"}, results=[Result(True, "claude-haiku", "anthropic")]
        )
        withheld = {"model": False, "provider": False}
        for again in ({"provider": "anthropic", "model": "haiku"}, {"provider": "anthropic", "model": "claude-haiku"}):
            saved, calls = self.set(again, gate=withheld)
            self.assertEqual(saved, {"provider": "anthropic", "model": "claude-haiku"})
            self.assertEqual(calls["switch"], [])


if __name__ == "__main__":
    unittest.main()


class Adapter:
    def __init__(self):
        self._run_statuses = {}

    def run(self, run_id, status, at, session="s1", **extra):
        self._run_statuses[run_id] = {
            "run_id": run_id,
            "session_id": session,
            "status": status,
            "created_at": at,
            "updated_at": at,
            **extra,
        }


class DeliveryTests(unittest.TestCase):
    """A message triaged to a thread meets that thread's run: steered, queued, or left in Main."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.path = db_path(self.home)
        self.adapter = Adapter()
        self.posted = []

        async def post(adapter, profile, path, request, authorization=None, idempotency_key=None):
            self.posted.append((path, request))
            return {"run_id": f"run_{len(self.posted)}"}

        for target, value in (
            (outbox, mock.patch.object(outbox, "post", post)),
            (outbox, mock.patch.object(outbox, "session_ids", mock.AsyncMock(return_value={"s1"}))),
        ):
            value.start()
            self.addCleanup(value.stop)
        self.found = {"decision": "thread", "thread": "t1", "session_id": "s1", "model_choice": None}
        self.body = {"model": "m", "provider": "p", "input": [{"role": "user", "content": "more"}], "session_id": "main"}

    def deliver(self, steer, files=()):
        return asyncio.run(
            triage.deliver(
                self.adapter, self.path, None, self.found, "more", list(files), self.body, steer
            )
        )

    def test_a_running_thread_is_steered_when_the_setting_says_so(self):
        self.adapter.run("r1", "running", 1)
        delivered = self.deliver(steer=True)
        self.assertTrue(delivered["steered"])
        self.assertEqual(self.posted, [("/v1/runs/r1/steer", {"input": "more"})])
        self.assertEqual(outbox.read(self.path, "s1")["items"], [])

    def test_a_running_thread_queues_when_the_setting_says_queue(self):
        self.adapter.run("r1", "running", 1)
        delivered = self.deliver(steer=False)
        self.assertFalse(delivered["steered"])
        self.assertEqual(self.posted, [])
        self.assertEqual([i["id"] for i in outbox.read(self.path, "s1")["items"]], [delivered["item"]["id"]])

    def test_a_waiting_thread_queues_even_when_steering(self):
        self.adapter.run("r1", "waiting_for_approval", 1)
        delivered = self.deliver(steer=True)
        self.assertFalse(delivered["steered"])
        self.assertEqual(self.posted, [])
        self.assertEqual(len(outbox.read(self.path, "s1")["items"]), 1)

    def test_a_message_carrying_a_file_steers_with_its_markers(self):
        """A file's content reaches the model as marker text, which a steer can carry."""
        self.adapter.run("r1", "running", 1)
        marker = '<attachment name="a.pdf" type="application/pdf" size="3" path="/h/a.pdf" />'
        self.body = {
            "model": "m",
            "provider": "p",
            "input": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "more"}, {"type": "text", "text": marker}],
                }
            ],
            "session_id": "main",
        }
        files = [{"name": "a.pdf", "type": "application/pdf", "size": 3, "path": "/h/a.pdf"}]
        delivered = self.deliver(steer=True, files=files)
        self.assertTrue(delivered["steered"])
        self.assertEqual(self.posted, [("/v1/runs/r1/steer", {"input": f"more\n{marker}"})])

    def test_a_message_carrying_a_photo_queues(self):
        """A photo's content rides in the message itself, and a steer is text alone."""
        self.adapter.run("r1", "running", 1)
        self.body["input"] = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image", "source": {"type": "base64", "data": "aGk="}},
                ],
            }
        ]
        files = [{"name": "cat.png", "type": "image/png", "size": 3, "path": "/h/cat.png"}]
        delivered = self.deliver(steer=True, files=files)
        self.assertFalse(delivered["steered"])
        self.assertEqual(self.posted, [])
        self.assertEqual(len(outbox.read(self.path, "s1")["items"]), 1, "it waits there instead")

    def test_a_photo_the_message_cant_hold_steers_as_text(self):
        """A model that takes no images reads a photo's marker line, which a steer carries."""
        self.adapter.run("r1", "running", 1)
        photo = '<attachment name="scan.png" type="image/png" size="3" path="/h/scan.png" />'
        self.body["input"][0]["content"] = [
            {"type": "text", "text": "more"},
            {"type": "text", "text": photo},
        ]
        files = [{"name": "scan.png", "type": "image/png", "size": 3, "path": "/h/scan.png"}]
        delivered = self.deliver(steer=True, files=files)
        self.assertTrue(delivered["steered"])
        self.assertEqual(self.posted, [("/v1/runs/r1/steer", {"input": f"more\n{photo}"})])

    def test_a_refused_steer_leaves_the_message_queued(self):
        self.adapter.run("r1", "running", 1)

        async def refuse(*args, **kwargs):
            raise outbox.StartError("conflict", True)

        with mock.patch.object(outbox, "post", refuse):
            delivered = self.deliver(steer=True)
        self.assertFalse(delivered["steered"])
        self.assertEqual(len(outbox.read(self.path, "s1")["items"]), 1)

    def test_a_stopped_thread_keeps_the_message_in_main(self):
        self.adapter.run("r1", "cancelled", 1)
        self.assertIsNone(self.deliver(steer=True))
        self.assertEqual(outbox.read(self.path, "s1")["items"], [])

    def test_a_thread_that_never_takes_the_message_is_not_pinned_by_it(self):
        """A stopped thread leaves the message in Main: nothing happened in that thread, no pin."""
        chats.merge(self.path, {"t1": {"at": 1, "value": {"hermesSessionId": "s1"}}})
        self.adapter.run("r1", "cancelled", 1)
        self.assertIsNone(self.deliver(steer=False))
        self.assertIsNone(chats.choice(chats.by_session(self.path, "s1")))

    def test_a_thread_runs_on_its_own_model_though_the_message_came_from_main(self):
        """A thread runs on its own model though the message was sent on Main's.

        The queued run is re-bound to the thread's pick, so a thread never moves with the profile's
        Default model.
        """
        self.adapter.run("r1", "running", 1)
        self.found["model_choice"] = {"provider": "deepseek", "model": "deepseek-v4-pro"}
        self.deliver(steer=False)
        self.adapter.run("r1", "completed", 1)
        asyncio.run(outbox.tick(self.adapter, "s1", None, self.path))
        path, request = self.posted[-1]
        self.assertEqual(path, "/v1/runs")
        self.assertEqual(
            (request["provider"], request["model"]),
            ("deepseek", "deepseek-v4-pro"),
            "the thread's own model, not the one the message was sent on",
        )

    def test_a_thread_with_no_pick_takes_the_model_its_next_send_names(self):
        """A triaged message is that thread's next send, so it pins there.

        The run names Main's model; a thread that has never pinned keeps it as its own pick, so it
        stops following the profile's Default from here on. A thread that already pinned keeps its
        own — see ``test_a_thread_that_already_pinned_keeps_its_own_model``.
        """
        chats.merge(self.path, {"t1": {"at": 1, "value": {"hermesSessionId": "s1"}}})
        self.adapter.run("r1", "running", 1)
        self.deliver(steer=False)
        self.adapter.run("r1", "completed", 1)
        asyncio.run(outbox.tick(self.adapter, "s1", None, self.path))
        path, request = self.posted[-1]
        self.assertEqual(
            (request["provider"], request["model"]),
            ("p", "m"),
            "the thread runs the model this send named",
        )
        self.assertEqual(
            chats.choice(chats.by_session(self.path, "s1")),
            {"provider": "p", "model": "m"},
            "and its record keeps that pick, so the next send doesn't follow the default",
        )

    def test_a_thread_that_already_pinned_keeps_its_own_model(self):
        """Main's model never overwrites a pick a thread already holds."""
        pinned = {"provider": "deepseek", "model": "deepseek-v4-pro"}
        chats.merge(
            self.path,
            {"t1": {"at": 1, "value": {"hermesSessionId": "s1", "modelChoice": pinned}}},
        )
        self.found["model_choice"] = pinned
        self.adapter.run("r1", "running", 1)
        self.deliver(steer=False)
        self.adapter.run("r1", "completed", 1)
        asyncio.run(outbox.tick(self.adapter, "s1", None, self.path))
        path, request = self.posted[-1]
        self.assertEqual((request["provider"], request["model"]), ("deepseek", "deepseek-v4-pro"))
        self.assertEqual(
            chats.choice(chats.by_session(self.path, "s1")), pinned, "its own pick, left alone"
        )

    def test_a_body_naming_half_a_pick_pins_nothing(self):
        """A run told a model with no provider is refused, not guessed at: so is a thread's pin."""
        chats.merge(self.path, {"t1": {"at": 1, "value": {"hermesSessionId": "s1"}}})
        self.body = {
            "model": "m",
            "input": [{"role": "user", "content": "more"}],
            "session_id": "main",
        }
        self.adapter.run("r1", "running", 1)
        self.deliver(steer=False)
        self.adapter.run("r1", "completed", 1)
        asyncio.run(outbox.tick(self.adapter, "s1", None, self.path))
        path, request = self.posted[-1]
        self.assertNotIn("provider", request)
        self.assertIsNone(
            chats.choice(chats.by_session(self.path, "s1")), "no half pick on the record either"
        )

    def test_a_queued_message_reaches_its_thread_with_no_app_connected(self):
        self.adapter.run("r1", "running", 1)
        delivered = self.deliver(steer=False)
        self.assertEqual(self.posted, [])
        self.adapter.run("r1", "completed", 1)
        asyncio.run(outbox.tick(self.adapter, "s1", None, self.path))
        path, request = self.posted[-1]
        self.assertEqual(path, "/v1/runs")
        self.assertEqual(request["session_id"], "s1")
        self.assertEqual(request["input"], self.body["input"])
        self.assertEqual(outbox.read(self.path, "s1")["items"], [])
        self.assertIsNotNone(delivered["item"]["id"])
