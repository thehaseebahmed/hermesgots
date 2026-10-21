"""Triage: a Main message stays or continues a thread, and every failure is Main.

Run: python3 -m unittest plugin.tests.test_triage -v
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from plugin import chats, triage
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
            triage, "_rows", return_value=[]
        ):
            return triage.triage(self.path, self.home, session, text)

    def test_stay_is_main(self):
        self.assertEqual(self.run_triage(Llm({"decision": "stay"})), {"decision": "main"})

    def test_continue_names_the_thread_and_its_session(self):
        found = self.run_triage(Llm({"decision": "continue", "thread": "t1"}))
        self.assertEqual(found, {"decision": "thread", "thread": "t1", "session_id": "s1"})

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

    def test_no_candidates_asks_no_model(self):
        chats.merge(self.path, {k: {"at": 2, "deleted": True} for k in ("t1", "t2")})
        llm = Llm({"decision": "continue", "thread": "t1"})
        self.assertEqual(self.run_triage(llm), {"decision": "main"})
        self.assertEqual(llm.calls, [])


class CandidateTests(unittest.TestCase):
    def pick(self, records):
        with mock.patch.object(triage, "_rows", return_value=[]):
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
        with mock.patch.object(triage, "_rows", return_value=[{"role": "user", "text": "hi\nthere"}]):
            found = triage.candidates(records, MAIN, Path("."))
        self.assertEqual(found, [{"id": "t", "title": "Lisbon", "last": "hi there", "active": 7}])


if __name__ == "__main__":
    unittest.main()
