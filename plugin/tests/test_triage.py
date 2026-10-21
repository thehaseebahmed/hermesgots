"""Triage: a Main message stays, continues a thread or opens a new one, and every failure is Main.

Run: python3 -m unittest plugin.tests.test_triage -v
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from plugin import chats, outbox, triage
from plugin.store import db_path

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
        self.assertEqual(self.run_triage(Llm({"decision": "new"}))["decision"], "new")

    def test_new_asks_for_a_thread_and_makes_nothing_yet(self):
        found = self.run_triage(Llm({"decision": "new", "thread": "t1"}))
        self.assertEqual(found["decision"], "new")
        self.assertEqual(found["main"]["hermesSessionId"], "memento-main-bot")
        self.assertEqual(set(chats.read(self.path)), {MAIN, "t1", "t2"})

    def test_open_thread_writes_the_record_a_new_chat_has(self):
        chat_id, session = triage.open_thread(self.path, self.records[MAIN]["value"])
        self.assertEqual(session, f"memento-{chat_id}")
        record = chats.read(self.path)[chat_id]
        self.assertEqual(record["at"], record["value"]["changedAt"])
        value = record["value"]
        self.assertEqual(
            (value["profileId"], value["title"], value["hermesSessionId"], value["createdAt"] == value["updatedAt"]),
            ("bot", "New chat", session, True),
        )
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
            self.path, "bot", self.records[MAIN]["value"], "plan my trip", files, body
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

    def test_a_thread_that_cant_be_started_leaves_no_record(self):
        before = set(chats.read(self.path))
        with self.assertRaises(ValueError):
            triage.start_thread(self.path, "bot", self.records[MAIN]["value"], "hi", [], {"input": []})
        after = chats.read(self.path)
        self.assertEqual({k for k, v in after.items() if not v.get("deleted")}, before)

    def test_discard_leaves_a_tombstone(self):
        chat_id, _ = triage.open_thread(self.path, self.records[MAIN]["value"])
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


if __name__ == "__main__":
    unittest.main()
