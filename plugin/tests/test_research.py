"""Research missions: the brief, the Scope Gate, the ledger and writing from it.

Run: python3 -m unittest plugin.tests.test_research -v
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import plugin
from plugin import research
from plugin.store import db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

PAGE = (
    "<html><head><style>p{}</style><script>var x = 1</script></head><body>"
    "<p>We propose a new simple network architecture, the <b>Transformer</b>, based solely on "
    "attention mechanisms, dispensing with recurrence and convolutions entirely.</p>"
    "<p>Multi-head attention allows the model to jointly attend to information from different "
    "representation subspaces.</p></body></html>"
)


class FakeLlm:
    """Answers each kind of call the way a model would, and remembers what it was asked."""

    def __init__(self) -> None:
        self.calls: list = []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        purpose = kwargs["purpose"].rsplit(".", 1)[-1]
        if purpose == "brief":
            parsed = {
                "title": "How transformers work",
                "goal": "Understand how transformers work.",
                "format": "guide",
                "audience": "A developer",
                "depth": "overview",
            }
        elif purpose == "outline":
            parsed = {"outline": ["Why attention", "Many heads"]}
        elif purpose == "section":
            parsed = {
                "title": "A section",
                "paragraphs": ["It drops recurrence. [c1] Several heads run at once [c2]. It is fast."],
            }
        elif purpose == "quiz":
            parsed = {
                "questions": [
                    {"question": "What does it drop?", "choices": ["Recurrence", "Attention"], "answer": 0, "cite": "c1"},
                    {"question": "Made up?", "choices": ["A", "B"], "answer": 0, "cite": "c99"},
                ]
            }
        elif purpose == "replan":
            parsed = {"outline": ["Why attention", "How is it trained?", "Many heads"]}
        elif purpose == "suggest":
            parsed = {"questions": ["Why attention", "How is it trained?", "How is it trained?"]}
        else:
            parsed = {"terms": [{"term": "Head", "definition": "One attention.", "cite": "c2"}]}
        return SimpleNamespace(parsed=parsed, text="")


def page_words(_url: str):
    return research._page_words(PAGE.encode(), "text/html; charset=utf-8")


class SpansTest(unittest.TestCase):
    def test_every_sentence_needs_a_known_marker(self) -> None:
        out = research.spans(
            "It drops recurrence. [c1] Several heads run at once [c2, c9]. It is fast. Ends [c9].",
            {"c1", "c2"},
        )
        self.assertEqual(
            out,
            [
                {"text": "It drops recurrence.", "cites": ["c1"]},
                {"text": " Several heads run at once.", "cites": ["c2"]},
                {"text": " It is fast.", "flagged": True},
                {"text": " Ends.", "flagged": True},
            ],
        )

    def test_text_after_the_last_marker_is_flagged(self) -> None:
        out = research.spans("Backed. [c1] Not backed.", {"c1"})
        self.assertEqual(out[-1], {"text": " Not backed.", "flagged": True})


class PassageTest(unittest.TestCase):
    def test_finds_a_passage_whatever_the_case_spacing_and_markup(self) -> None:
        page = page_words("")
        self.assertTrue(
            research.check_passage(page, "based solely on  ATTENTION mechanisms, dispensing with recurrence")
        )
        self.assertTrue(research.check_passage(page, "the Transformer, based solely … convolutions entirely."))
        self.assertFalse(research.check_passage(page, "Transformers are the best model ever made."))
        self.assertNotIn("var x", page)

    def test_an_unread_page_is_unknown(self) -> None:
        self.assertIsNone(research.check_passage(None, "anything at all here"))
        self.assertIsNone(research._page_words(b"%PDF-1.7", "application/pdf"))


class MissionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "gots.db"
        self.llm = FakeLlm()
        research.ctx = SimpleNamespace(llm=self.llm)
        notify = mock.patch.object(research.push, "notify")
        self.notify = notify.start()
        self.addCleanup(notify.stop)

    def told(self) -> list:
        return [(call.args[0], call.kwargs.get("title")) for call in self.notify.call_args_list]

    def tearDown(self) -> None:
        research.ctx = None
        self.dir.cleanup()

    def claim(self, snippet: str, url: str = "https://arxiv.org/abs/1706.03762", fetch=page_words):
        return research.record(
            self.path,
            self.mission["id"],
            {"claim": "A fact.", "url": url, "title": "Attention Is All You Need", "kind": "papers", "snippet": snippet},
            fetch,
        )

    def reach_reading(self) -> None:
        self.mission = research.create(self.path, None, "explain transformers")
        self.assertEqual(self.mission["busy"], "brief")
        research._job(self.path, self.mission["id"])
        found = research.mission(self.path, self.mission["id"])
        self.assertEqual((found["title"], found["busy"]), ("How transformers work", None))
        research.confirm_brief(
            self.path, found["id"], {"goal": found["goal"], "audience": "A developer", "format": "guide", "depth": "overview"}
        )
        research._job(self.path, found["id"])
        found = research.mission(self.path, found["id"])
        self.assertEqual((found["stage"], found["outline"]), ("scope", ["Why attention", "Many heads"]))
        found = research.approve_scope(
            self.path, found["id"], {"outline": found["outline"], "source_kinds": ["papers"]}
        )
        self.assertEqual(found["stage"], "reading")

    def test_the_model_the_researcher_ran_on_is_kept(self) -> None:
        # The store sits in the profile's gots folder, beside Hermes's own state.db.
        self.path = Path(self.dir.name) / "plugin-data" / "gots" / "gots.db"
        state = sqlite3.connect(Path(self.dir.name) / "state.db")
        state.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, billing_provider TEXT)")
        self.reach_reading()
        state.execute(
            "INSERT INTO sessions VALUES (?, 'claude-opus-5-5', 'anthropic')",
            (f"research-{self.mission['id']}",),
        )
        state.commit()
        state.close()
        self.assertIsNone(research.mission(self.path, self.mission["id"])["researcher"])
        self.claim("based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.")
        self.claim("Multi-head attention allows the model to jointly attend to information")
        self.claim("A passage from a PDF that can't be read.", "https://example.com/a.pdf", lambda _u: None)
        research.finished_reading(self.path, self.mission["id"], "completed")
        self.assertEqual(
            research.mission(self.path, self.mission["id"])["researcher"],
            {"provider": "anthropic", "model": "claude-opus-5-5"},
        )

    def test_a_mission_from_question_to_guide_and_quiz(self) -> None:
        self.reach_reading()
        first = self.claim("based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.")
        self.assertEqual((first["id"], first["source"], first["checked"]), ("c1", "s1", True))
        self.claim("Multi-head attention allows the model to jointly attend to information")
        third = self.claim("A passage from a PDF that can't be read.", "https://example.com/a.pdf", lambda _u: None)
        self.assertEqual((third["source"], third["confidence"]), ("s2", "uncertain"))

        self.assertTrue(research.finished_reading(self.path, self.mission["id"], "completed"))
        research._job(self.path, self.mission["id"])
        found = research.mission(self.path, self.mission["id"])
        self.assertEqual((found["stage"], found["formats"], found["written"]), ("delivered", ["guide"], 2))
        sections = found["outputs"]["guide"]["sections"]
        self.assertEqual(len(sections), 2)
        self.assertEqual(sections[0]["paragraphs"][0][-1], {"text": " It is fast.", "flagged": True})
        # The writer saw the ledger, passages included.
        writer = [call for call in self.llm.calls if call["purpose"].endswith(".section")][-1]
        self.assertIn('[c1] A fact.', writer["input"][0]["text"])

        research.make_format(self.path, found["id"], "quiz")
        research._job(self.path, found["id"])
        found = research.mission(self.path, found["id"])
        self.assertEqual((found["formats"], found["making"]), (["guide", "quiz"], None))
        # A question citing a claim that isn't in the ledger is dropped.
        self.assertEqual([q["cite"] for q in found["outputs"]["quiz"]["questions"]], ["c1"])

    def test_the_user_is_told_when_a_mission_needs_them_or_is_ready(self) -> None:
        self.reach_reading()
        self.assertEqual(
            self.told(),
            [("research_brief", "How transformers work"), ("research_scope", "How transformers work")],
        )
        for snippet in ("based solely on attention mechanisms", "Multi-head attention allows the model", "dispensing with recurrence"):
            self.claim(snippet)
        research.finished_reading(self.path, self.mission["id"], "completed")
        research._job(self.path, self.mission["id"])
        self.assertEqual(self.told()[-1], ("research_done", "How transformers work"))
        # Another format the user just asked for isn't news.
        research.make_format(self.path, self.mission["id"], "quiz")
        research._job(self.path, self.mission["id"])
        self.assertEqual(len(self.told()), 3)
        self.assertEqual(self.notify.call_args.args[1], self.mission["id"])

    def deliver(self) -> dict:
        self.reach_reading()
        for snippet in ("based solely on attention mechanisms", "Multi-head attention allows the model", "dispensing with recurrence"):
            self.claim(snippet)
        research.finished_reading(self.path, self.mission["id"], "completed")
        research._job(self.path, self.mission["id"])
        research.make_format(self.path, self.mission["id"], "quiz")
        research._job(self.path, self.mission["id"])
        return research.mission(self.path, self.mission["id"])

    def test_questions_it_missed_are_read_for_and_the_whole_mission_written_again(self) -> None:
        found = self.deliver()
        # What it still leaves open, without what the outline already covers or repeats.
        self.assertEqual(found["suggestions"], ["How is it trained?"])
        self.assertEqual([(r["number"], r["reason"]) for r in found["revisions"]], [(1, "first")])
        first = found["outputs"]["guide"]["sections"]
        quizzes = sum(1 for call in self.llm.calls if call["purpose"].endswith(".quiz"))

        found = research.followup(self.path, found["id"], {"questions": ["How is it trained?", " ", "why attention"]})
        self.assertEqual(found["stage"], "reading")
        # The write-up stays as it was while the researcher reads.
        self.assertEqual(found["outline"], ["Why attention", "Many heads"])
        self.assertEqual(found["outputs"]["guide"]["sections"], first)
        self.assertEqual((found["written"], found["suggestions"], found["claims"]), (2, [], 3))
        self.assertEqual([r["questions"] for r in found["followups"]], [["How is it trained?"]])
        self.assertEqual(found["pending"], {"reason": "followup", "questions": ["How is it trained?"]})
        prompt = research.researcher_prompt(found)
        self.assertIn("missed these questions:\n- How is it trained?", prompt)
        self.assertIn("already holds 3 claims", prompt)
        self.assertEqual(research.run_body(found)["session_id"], f"research-{found['id']}")

        # Nothing new is a failure of the round, not of the mission's ledger.
        research.finished_reading(self.path, found["id"], "completed")
        found = research.mission(self.path, found["id"])
        self.assertEqual(found["error"], "The researcher found nothing new on those questions.")
        research.retry(self.path, found["id"])
        self.claim("jointly attend to information from different representation subspaces")
        research.finished_reading(self.path, found["id"], "completed")
        self.assertEqual(research.mission(self.path, found["id"])["written"], 2)
        research._job(self.path, found["id"])

        found = research.mission(self.path, found["id"])
        self.assertEqual((found["stage"], found["formats"], found["pending"]), ("delivered", ["guide", "quiz"], None))
        # Planned again with the question worked in, and every section written again.
        self.assertEqual(found["outline"], ["Why attention", "How is it trained?", "Many heads"])
        self.assertEqual((len(found["outputs"]["guide"]["sections"]), found["written"]), (3, 3))
        sections = [c for c in self.llm.calls if c["purpose"].endswith(".section")]
        self.assertIn("This section covers: How is it trained?", sections[-2]["instructions"])
        self.assertEqual(len(sections), 5)
        # The quiz was written again from the grown ledger.
        self.assertEqual(sum(1 for c in self.llm.calls if c["purpose"].endswith(".quiz")), quizzes + 1)
        self.assertEqual(self.told()[-1], ("research_done", "How transformers work"))
        revisions = found["revisions"]
        self.assertEqual(
            [(r["number"], r["reason"], r.get("questions"), r["claims"]) for r in revisions],
            [(1, "first", None, 3), (2, "followup", ["How is it trained?"], 4)],
        )
        # Each revision keeps what it delivered.
        self.assertEqual(revisions[0]["outputs"]["guide"]["sections"], first)
        self.assertEqual(revisions[0]["outline"], ["Why attention", "Many heads"])
        self.assertEqual(len(revisions[1]["outputs"]["guide"]["sections"]), 3)

    def test_a_mission_is_rewritten_with_another_model(self) -> None:
        found = self.deliver()
        with mock.patch.object(research, "llm_gate", return_value={"model": False, "provider": False}):
            with self.assertRaises(research.ResearchError) as refused:
                research.rewrite(self.path, found["id"], {"provider": "openrouter", "model": "x/y"})
        self.assertEqual(refused.exception.status, 403)

        with mock.patch.object(research, "llm_gate", return_value={"model": True, "provider": True}):
            found = research.rewrite(self.path, found["id"], {"provider": "openrouter", "model": "x/y"})
        self.assertEqual((found["stage"], found["writer"]), ("drafting", {"provider": "openrouter", "model": "x/y"}))
        before = len(self.llm.calls)
        research._job(self.path, found["id"])
        found = research.mission(self.path, found["id"])
        self.assertEqual((found["stage"], found["formats"], found["pending"]), ("delivered", ["guide", "quiz"], None))
        written = [c for c in self.llm.calls[before:] if c["purpose"].rsplit(".", 1)[-1] in ("section", "quiz")]
        self.assertEqual(len(written), 3)
        self.assertTrue(all((c["provider"], c["model"]) == ("openrouter", "x/y") for c in written))
        self.assertEqual(
            [(r["reason"], r.get("model")) for r in found["revisions"]],
            [("first", None), ("rewrite", {"provider": "openrouter", "model": "x/y"})],
        )

        # Default goes back to the profile's own model, with no override.
        found = research.rewrite(self.path, found["id"], {})
        self.assertIsNone(found["writer"])
        before = len(self.llm.calls)
        research._job(self.path, found["id"])
        self.assertTrue(all("model" not in c for c in self.llm.calls[before:]))
        self.assertEqual(len(research.mission(self.path, found["id"])["revisions"]), 3)

    def test_only_a_delivered_mission_is_rewritten(self) -> None:
        self.reach_reading()
        with self.assertRaises(research.ResearchError) as early:
            research.rewrite(self.path, self.mission["id"], {})
        self.assertEqual(early.exception.status, 409)

    def test_follow_up_questions_are_checked(self) -> None:
        self.reach_reading()
        with self.assertRaises(research.ResearchError) as moved:
            research.followup(self.path, self.mission["id"], {"questions": ["Anything?"]})
        self.assertEqual(moved.exception.status, 409)
        found = self.deliver()
        for questions, message in (
            ("Why?", "at least one"),
            (["many heads"], "hasn't covered"),
            (["A?", "B?", "C?", "D?"], "3 questions at most"),
            (["x" * 201], "too long"),
        ):
            with self.assertRaisesRegex(research.ResearchError, message):
                research.followup(self.path, found["id"], {"questions": questions})
        research._update(self.path, found["id"], outline=[f"Point {n}" for n in range(research.MAX_OUTLINE)])
        with self.assertRaisesRegex(research.ResearchError, "Start a new one"):
            research.followup(self.path, found["id"], {"questions": ["One more?"]})

    def test_a_failed_step_is_told(self) -> None:
        self.reach_reading()
        research.finished_reading(self.path, self.mission["id"], "completed")
        self.assertEqual(self.told()[-1], ("research_failed", "How transformers work"))
        research._fail(self.path, self.mission["id"], "The model is down.")
        self.assertEqual(self.told()[-1], ("research_failed", "How transformers work"))

    def test_a_passage_the_page_doesnt_hold_is_refused(self) -> None:
        self.reach_reading()
        with self.assertRaisesRegex(research.ResearchError, "isn't on the page"):
            self.claim("Transformers were invented in 1950 by a committee.")
        self.assertEqual(research.mission(self.path, self.mission["id"])["claims"], 0)

    def test_claims_only_while_reading(self) -> None:
        self.mission = research.create(self.path, None, "explain transformers")
        with self.assertRaisesRegex(research.ResearchError, "isn't reading"):
            self.claim("based solely on attention mechanisms")

    def test_too_few_claims_fail_the_reading(self) -> None:
        self.reach_reading()
        self.claim("based solely on attention mechanisms, dispensing with recurrence")
        self.assertFalse(research.finished_reading(self.path, self.mission["id"], "running"))
        self.assertTrue(research.finished_reading(self.path, self.mission["id"], "completed"))
        found = research.mission(self.path, self.mission["id"])
        self.assertEqual(found["stage"], "reading")
        self.assertIn("too few sources", found["error"])
        self.assertEqual(research.retry(self.path, found["id"])["error"], None)

    def test_the_scope_gate_checks_its_input(self) -> None:
        self.mission = research.create(self.path, None, "explain transformers")
        research._job(self.path, self.mission["id"])
        with self.assertRaisesRegex(research.ResearchError, "moved on"):
            research.approve_scope(self.path, self.mission["id"], {"outline": ["A"], "source_kinds": ["papers"]})
        research.confirm_brief(
            self.path, self.mission["id"], {"goal": "G", "audience": "A", "format": "guide", "depth": "deep"}
        )
        research._job(self.path, self.mission["id"])
        with self.assertRaisesRegex(research.ResearchError, "kinds of source"):
            research.approve_scope(self.path, self.mission["id"], {"outline": ["A"], "source_kinds": ["tv"]})
        with self.assertRaisesRegex(research.ResearchError, "needs a point"):
            research.approve_scope(self.path, self.mission["id"], {"outline": [" "], "source_kinds": ["papers"]})

    def test_the_watcher_waits_for_a_run_to_show_up_then_for_it_to_end(self) -> None:
        self.reach_reading()
        for snippet in ("based solely on attention mechanisms", "dispensing with recurrence and convolutions", "Multi-head attention allows the model"):
            self.claim(snippet)
        research.adapter = SimpleNamespace(_run_statuses={})
        self.addCleanup(setattr, research, "adapter", None)
        research.watch(self.path, self.mission["id"], None)
        research.set_run(self.path, self.mission["id"], "run_1")
        # Not listed yet: a run just started, not one that ended.
        self.assertEqual(research._check_watched(), [])
        research.adapter._run_statuses["run_1"] = {"run_id": "run_1", "status": "running"}
        self.assertEqual(research._check_watched(), [])
        del research.adapter._run_statuses["run_1"]
        self.assertEqual([m for _p, m, _r in research._check_watched()], [self.mission["id"]])
        self.assertEqual(research.mission(self.path, self.mission["id"])["stage"], "drafting")

    def test_a_researcher_only_reads(self) -> None:
        self.assertEqual(
            research.before_tool(tool_name="terminal", task_id="research-r_1")["action"], "block"
        )
        self.assertIsNone(research.before_tool(tool_name="web_extract", task_id="research-r_1"))
        self.assertIsNone(research.before_tool(tool_name="terminal", task_id="gots-chat"))


class FakeCompareLlm(FakeLlm):
    """The comparison's calls: the brief names options, each advocate argues, the judge scores."""

    def complete_structured(self, **kwargs):
        purpose = kwargs["purpose"].rsplit(".", 1)[-1]
        if purpose == "brief":
            self.calls.append(kwargs)
            parsed = {
                "title": "Bun or Node",
                "goal": "Decide which runtime to build on.",
                "audience": "A developer",
                "depth": "overview",
                "options": ["Bun", "Node.js", "Bun"],
                "criteria": [{"name": "Speed", "weight": 5}, {"name": "Maturity", "weight": 2}],
            }
        elif purpose in ("case", "rebuttal"):
            self.calls.append(kwargs)
            parsed = {"paragraphs": ["It is built around attention. [c1] It is also quick."]}
        elif purpose == "judge":
            self.calls.append(kwargs)
            parsed = {
                "scores": [
                    {"option": "o1", "criterion": "k1", "score": 9, "reason": "Quick.", "claims": ["c1"]},
                    {"option": "o1", "criterion": "k2", "score": 4, "reason": "Young.", "claims": ["c99"]},
                    {"option": "o2", "criterion": "k1", "score": 5, "reason": "Fine.", "claims": ["c2"]},
                    {"option": "o2", "criterion": "k2", "score": 14, "reason": "Old.", "claims": ["c2"]},
                    {"option": "o9", "criterion": "k1", "score": 1, "reason": "Ghost.", "claims": ["c1"]},
                ],
                "ruled_out": [
                    {"option": "o2", "criterion": "k1", "claim": "c99"},
                    {"option": "o1", "criterion": "k2", "claim": "c2"},
                ],
                "verdict": ["Bun leads on speed. [c1] It is young."],
                "flip": ["A mature ecosystem would flip it. [c2]"],
            }
        else:
            return super().complete_structured(**kwargs)
        return SimpleNamespace(parsed=parsed, text="")


class CompareTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "gots.db"
        self.llm = FakeCompareLlm()
        research.ctx = SimpleNamespace(llm=self.llm)
        notify = mock.patch.object(research.push, "notify")
        self.notify = notify.start()
        self.addCleanup(notify.stop)
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(setattr, research, "ctx", None)

    def claim(self, snippet: str, **tags):
        return research.record(
            self.path,
            self.mission["id"],
            {"claim": "A fact.", "url": "https://arxiv.org/abs/1706.03762", "title": "A page", "kind": "papers", "snippet": snippet, **tags},
            page_words,
        )

    def reach_reading(self) -> None:
        self.mission = research.create(self.path, None, "bun or node", "compare")
        self.assertEqual((self.mission["type"], self.mission["format"]), ("compare", "memo"))
        research._job(self.path, self.mission["id"])
        found = research.mission(self.path, self.mission["id"])
        # The brief names the options (a repeated one once) and numbers them with the criteria.
        self.assertEqual([o["id"] for o in found["options"]], ["o1", "o2"])
        self.assertEqual([(k["id"], k["weight"]) for k in found["criteria"]], [("k1", 5), ("k2", 2)])
        found = research.confirm_brief(
            self.path,
            found["id"],
            {
                "goal": found["goal"], "audience": "A developer", "depth": "overview",
                "options": found["options"], "criteria": [{"name": "Speed", "weight": 5}, {"name": "Maturity", "weight": 2}],
            },
        )
        # No outline call: the criteria are what is researched, and the user is told at once.
        self.assertEqual((found["stage"], found["busy"], found["outline"]), ("scope", None, ["Speed", "Maturity"]))
        found = research.approve_scope(self.path, found["id"], {"source_kinds": ["papers"]})
        self.assertEqual((found["stage"], found["judge"]), ("reading", None))

    def test_a_comparison_from_question_to_memo(self) -> None:
        self.reach_reading()
        self.claim("based solely on attention mechanisms, dispensing with recurrence", option="o1", criterion="k1")
        self.claim("Multi-head attention allows the model to jointly attend", option="o2", criterion="k1")
        with self.assertRaisesRegex(research.ResearchError, "which option"):
            self.claim("dispensing with recurrence and convolutions entirely.")
        with self.assertRaisesRegex(research.ResearchError, "option must be one of"):
            self.claim("dispensing with recurrence and convolutions entirely.", option="o7")
        with self.assertRaisesRegex(research.ResearchError, "criterion must be one of"):
            self.claim("dispensing with recurrence and convolutions entirely.", option="o1", criterion="k9")
        # Two options need at least four claims.
        self.assertFalse(research.finished_reading(self.path, self.mission["id"], "running"))
        self.assertTrue(research.finished_reading(self.path, self.mission["id"], "completed"))
        self.assertIn("too few", research.mission(self.path, self.mission["id"])["error"])
        research.retry(self.path, self.mission["id"])
        self.claim("dispensing with recurrence and convolutions entirely.", option="o1", criterion="k2")
        self.claim("jointly attend to information from different", option="o2", criterion="k2")
        self.assertTrue(research.finished_reading(self.path, self.mission["id"], "completed"))

        research._job(self.path, self.mission["id"])
        found = research.mission(self.path, self.mission["id"])
        self.assertEqual((found["stage"], found["formats"], found["written"]), ("delivered", ["memo"], 5))
        memo = found["outputs"]["memo"]
        self.assertEqual([o["name"] for o in memo["options"]], ["Bun", "Node.js"])
        self.assertTrue(all(o["case"] and o["rebuttal"] for o in memo["options"]))
        # An advocate sees its option's claims and nobody else's, and the judge sees every case.
        case = [c for c in self.llm.calls if c["purpose"].endswith(".case")][0]
        self.assertIn("(Bun / Speed)", case["input"][0]["text"])
        self.assertNotIn("(Node.js", case["input"][0]["text"])
        judge = [c for c in self.llm.calls if c["purpose"].endswith(".judge")][0]
        self.assertIn("Case:", judge["input"][0]["text"])
        self.assertEqual(memo["judged_by"], None)

        # The judge's scores are checked: an unknown claim, option or a score out of range doesn't pass.
        cells = memo["scores"]
        self.assertEqual(cells["o1"]["k1"], {"score": 9, "reason": "Quick.", "claims": ["c1"], "flagged": False})
        self.assertTrue(cells["o1"]["k2"]["flagged"])
        self.assertEqual(cells["o2"]["k2"]["score"], 10)
        self.assertNotIn("o9", cells)
        # Only a ruling backed by a claim in the ledger stands.
        self.assertEqual(memo["ruled_out"], [{"option": "o1", "criterion": "k2", "claim": "c2"}])
        self.assertEqual(memo["verdict"][0][0], {"text": "Bun leads on speed.", "cites": ["c1"]})
        self.assertEqual(memo["verdict"][0][1], {"text": " It is young.", "flagged": True})

        # The ranking is code: o1 is ruled out, so o2 leads whatever the scores say.
        decision = found["decision"]
        self.assertEqual(decision["leader"], "o2")
        self.assertEqual([r["option"] for r in decision["ranking"]], ["o2", "o1"])
        self.assertEqual(decision["ranking"][1]["ruled_out"], True)
        self.assertEqual(found["claims"], 4)
        self.assertEqual(research.mission(self.path, found["id"])["revisions"][0]["reason"], "first")
        self.assertEqual(self.notify.call_args.args[0], "research_done")

    def test_the_ranking_weighs_scores_and_calls_a_near_tie(self) -> None:
        options = [{"id": "o1", "name": "A"}, {"id": "o2", "name": "B"}]
        criteria = [{"id": "k1", "name": "X", "weight": 5}, {"id": "k2", "name": "Y", "weight": 1}]

        def cell(score):
            return {"score": score, "reason": "r", "claims": ["c1"], "flagged": False}

        memo = {"scores": {"o1": {"k1": cell(8), "k2": cell(2)}, "o2": {"k1": cell(7), "k2": cell(10)}}}
        decision = research.decide(options, criteria, memo)
        # A: (8*5 + 2) / 60 = 70; B: (7*5 + 10) / 60 = 75.
        self.assertEqual([(r["option"], r["total"]) for r in decision["ranking"]], [("o2", 75), ("o1", 70)])
        self.assertEqual((decision["leader"], decision["margin"], decision["close"]), ("o2", 5, True))
        self.assertEqual(research.decide(options, criteria, None)["ranking"], [])
        # A missing cell is thin, and counts for nothing.
        thin = research.decide(options, criteria, {"scores": {"o1": {"k1": cell(10)}, "o2": {}}})
        self.assertEqual(thin["ranking"][0]["thin"], ["k2"])

    def test_the_brief_and_the_scope_gate_check_a_comparison(self) -> None:
        self.mission = research.create(self.path, None, "bun or node", "compare")
        research._job(self.path, self.mission["id"])
        base = {"goal": "G", "audience": "A", "depth": "overview"}
        with self.assertRaisesRegex(research.ResearchError, "Compare 2 to 5"):
            research.confirm_brief(
                self.path, self.mission["id"], {**base, "options": ["Bun"], "criteria": [{"name": "X", "weight": 1}, {"name": "Y", "weight": 1}]}
            )
        with self.assertRaisesRegex(research.ResearchError, "weight"):
            research.confirm_brief(
                self.path, self.mission["id"], {**base, "options": ["A", "B"], "criteria": [{"name": "X", "weight": 9}, {"name": "Y", "weight": 1}]}
            )
        with self.assertRaisesRegex(research.ResearchError, "2 to 6 criteria"):
            research.confirm_brief(self.path, self.mission["id"], {**base, "options": ["A", "B"], "criteria": [{"name": "X", "weight": 1}]})
        research.confirm_brief(
            self.path, self.mission["id"],
            {**base, "options": ["A", "B"], "criteria": [{"name": "X", "weight": 1}, {"name": "Y", "weight": 2}]},
        )
        # The judge is a model pick, so the host has to allow it.
        with mock.patch.object(research, "llm_gate", return_value={"model": False, "provider": False}):
            with self.assertRaisesRegex(research.ResearchError, "doesn't let Gots pick"):
                research.approve_scope(self.path, self.mission["id"], {"source_kinds": ["papers"], "judge": {"model": "m"}})
        with mock.patch.object(research, "llm_gate", return_value={"model": True, "provider": True}):
            found = research.approve_scope(
                self.path, self.mission["id"], {"source_kinds": ["papers"], "judge": {"provider": "p", "model": "m"}}
            )
        self.assertEqual(found["judge"], {"provider": "p", "model": "m"})

    def test_the_judge_uses_its_own_model(self) -> None:
        self.reach_reading()
        research._update(self.path, self.mission["id"], judge={"model": "big"}, writer={"model": "small"})
        for index, (option, criterion) in enumerate((("o1", "k1"), ("o2", "k1"), ("o1", "k2"), ("o2", "k2"))):
            self.claim("dispensing with recurrence and convolutions entirely.", option=option, criterion=criterion)
        research.finished_reading(self.path, self.mission["id"], "completed")
        research._job(self.path, self.mission["id"])
        by_purpose = {c["purpose"].rsplit(".", 1)[-1]: c.get("model") for c in self.llm.calls}
        self.assertEqual((by_purpose["case"], by_purpose["judge"]), ("small", "big"))

    def test_a_comparison_has_no_other_formats(self) -> None:
        self.reach_reading()
        for option, criterion in (("o1", "k1"), ("o2", "k1"), ("o1", "k2"), ("o2", "k2")):
            self.claim("dispensing with recurrence and convolutions entirely.", option=option, criterion=criterion)
        research.finished_reading(self.path, self.mission["id"], "completed")
        research._job(self.path, self.mission["id"])
        with self.assertRaisesRegex(research.ResearchError, "one format"):
            research.make_format(self.path, self.mission["id"], "quiz")
        with self.assertRaisesRegex(research.ResearchError, "Learn & understand"):
            research.followup(self.path, self.mission["id"], {"questions": ["Why?"]})
        with self.assertRaisesRegex(research.ResearchError, "Only a Learn"):
            research.rewrite(self.path, self.mission["id"], {})
        prompt = research.researcher_prompt(research.mission(self.path, self.mission["id"]))
        self.assertIn("o1: Bun", prompt)
        self.assertIn("k1: Speed (weight 5 of 5)", prompt)


class FakeVerifyLlm(FakeLlm):
    """A verification's brief: the claim read back neutrally, as parts, or as not checkable."""

    def complete_structured(self, **kwargs):
        purpose = kwargs["purpose"].rsplit(".", 1)[-1]
        if purpose != "brief":
            return super().complete_structured(**kwargs)
        self.calls.append(kwargs)
        if "best editor" in kwargs["input"][0]["text"]:
            parsed = {
                "title": "The best editor",
                "restatement": "Vim is the best editor.",
                "parts": ["Vim is the best editor"],
                "terms": [],
                "checkable": False,
                "reason": "It is a matter of taste.",
            }
        else:
            parsed = {
                "title": "Coffee and heart attacks",
                "restatement": "Drinking coffee daily raises the risk of a heart attack.",
                "parts": ["Coffee is drunk daily", "The risk of a heart attack rises", "", "A", "B", "C"],
                "terms": ["daily", "heart attack"],
                "checkable": True,
                "reason": "",
            }
        return SimpleNamespace(parsed=parsed, text="")


class FakeVerdictLlm(FakeVerifyLlm):
    """A verification's judge: tags per part, some naming a claim or a part the mission lacks."""

    TAGS = [
        {"part": "p1", "claims": [{"claim": "c1", "stance": "supports"}, {"claim": "c2", "stance": "supports"},
                                  {"claim": "c9", "stance": "supports"}, {"claim": "c4", "stance": "maybe"}]},
        {"part": "p2", "claims": [{"claim": "c3", "stance": "refutes"}, {"claim": "c4", "stance": "context"}]},
        {"part": "p9", "claims": [{"claim": "c1", "stance": "refutes"}]},
    ]

    def __init__(self, tags=None) -> None:
        super().__init__()
        self.tags = self.TAGS if tags is None else tags

    def complete_structured(self, **kwargs):
        if kwargs["purpose"].rsplit(".", 1)[-1] != "verdict":
            return super().complete_structured(**kwargs)
        self.calls.append(kwargs)
        parsed = {
            "parts": self.tags,
            "change": ["A trial that tracked daily drinkers would settle it. [c1]", "Nobody has looked at it."],
        }
        return SimpleNamespace(parsed=parsed, text="")


class VerifyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "gots.db"
        self.llm = FakeVerifyLlm()
        research.ctx = SimpleNamespace(llm=self.llm)
        notify = mock.patch.object(research.push, "notify")
        self.notify = notify.start()
        self.addCleanup(notify.stop)
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(setattr, research, "ctx", None)

    def told(self) -> list:
        return [call.args[0] for call in self.notify.call_args_list]

    def test_a_claim_is_read_back_as_parts_and_confirmed_without_an_outline_call(self) -> None:
        loaded = "Coffee KILLS you: every daily cup is a heart attack waiting to happen!!"
        found = research.create(self.path, None, loaded, "verify")
        self.assertEqual((found["type"], found["stage"], found["busy"]), ("verify", "brief", "brief"))
        research._job(self.path, found["id"])
        found = research.mission(self.path, found["id"])
        # The read-back is kept beside the user's own words, which stay as they were typed.
        self.assertEqual(found["input"], loaded)
        self.assertEqual(found["restatement"], "Drinking coffee daily raises the risk of a heart attack.")
        # Blank parts are dropped and at most four are kept, numbered in order.
        self.assertEqual(
            found["parts"],
            [
                {"id": "p1", "text": "Coffee is drunk daily"},
                {"id": "p2", "text": "The risk of a heart attack rises"},
                {"id": "p3", "text": "A"},
                {"id": "p4", "text": "B"},
            ],
        )
        self.assertEqual(found["terms"], ["daily", "heart attack"])
        self.assertIsNone(found["uncheckable"])
        self.assertEqual((found["stage"], found["busy"], found["title"]), ("brief", None, "Coffee and heart attacks"))
        self.assertEqual(self.told(), ["research_brief"])

        base = {"restatement": "Drinking coffee every day raises heart attack risk."}
        with self.assertRaisesRegex(research.ResearchError, "1 to 4 parts"):
            research.confirm_brief(self.path, found["id"], {**base, "parts": ["a", "b", "c", "d", "e"]})
        with self.assertRaisesRegex(research.ResearchError, "1 to 4 parts"):
            research.confirm_brief(self.path, found["id"], {**base, "parts": [" ", ""]})
        with self.assertRaisesRegex(research.ResearchError, "8 terms at most"):
            research.confirm_brief(self.path, found["id"], {**base, "parts": ["a"], "terms": [str(i) for i in range(9)]})
        with self.assertRaisesRegex(research.ResearchError, "A term is too long"):
            research.confirm_brief(self.path, found["id"], {**base, "parts": ["a"], "terms": ["x" * 61]})
        with self.assertRaisesRegex(research.ResearchError, "restatement is required"):
            research.confirm_brief(self.path, found["id"], {"restatement": " ", "parts": ["a"]})

        found = research.confirm_brief(
            self.path,
            found["id"],
            {
                **base,
                "parts": ["", "Heart attack risk rises", {"text": "Coffee is drunk daily"}],
                "terms": [" every day ", "", "Heart attack", "heart attack", 7],
            },
        )
        # The edited terms are kept, trimmed, blanks and repeats (whatever their case) dropped.
        self.assertEqual(found["terms"], ["every day", "Heart attack"])
        # The edited parts are renumbered, they are the outline, and no outline call is made.
        self.assertEqual(found["restatement"], "Drinking coffee every day raises heart attack risk.")
        self.assertEqual(
            found["parts"],
            [{"id": "p1", "text": "Heart attack risk rises"}, {"id": "p2", "text": "Coffee is drunk daily"}],
        )
        self.assertEqual(
            (found["stage"], found["busy"], found["outline"]),
            ("scope", None, ["Heart attack risk rises", "Coffee is drunk daily"]),
        )
        self.assertEqual(found["input"], loaded)
        self.assertEqual([c["purpose"] for c in self.llm.calls], ["gots.research.brief"])
        self.assertEqual(self.told(), ["research_brief", "research_scope"])

    def test_a_claim_that_cannot_be_checked_stops_at_the_brief(self) -> None:
        found = research.create(self.path, None, "Vim is the best editor", "verify")
        research._job(self.path, found["id"])
        found = research.mission(self.path, found["id"])
        self.assertEqual((found["stage"], found["busy"], found["error"]), ("brief", None, None))
        self.assertEqual(found["uncheckable"], "It is a matter of taste.")
        self.assertEqual(found["restatement"], "Vim is the best editor.")
        with self.assertRaisesRegex(research.ResearchError, "can't be checked") as refused:
            research.confirm_brief(self.path, found["id"], {"restatement": "Vim is fast.", "parts": ["Vim is fast"]})
        self.assertEqual(refused.exception.status, 409)
        after = research.mission(self.path, found["id"])
        self.assertEqual(
            (after["stage"], after["restatement"], after["parts"], after["outline"]),
            ("brief", "Vim is the best editor.", found["parts"], []),
        )


class ResearcherRunTest(unittest.TestCase):
    """The researcher's run as the routes start, retry and stop it, and as the watcher follows it
    across a store upgrade."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.adapter = RouteAdapter()
        self.adapter._run_statuses = {}
        json_response = mock.patch.object(
            FakeWeb, "json_response", staticmethod(lambda payload, status=200: SimpleNamespace(status=status, payload=payload))
        )
        json_response.start()
        self.addCleanup(json_response.stop)
        self.app = wire(self, self.adapter)
        self.addCleanup(setattr, research, "adapter", None)
        self.addCleanup(setattr, research, "ctx", None)
        self.llm = FakeLlm()
        research.ctx = SimpleNamespace(llm=self.llm)
        notify = mock.patch.object(research.push, "notify")
        self.notify = notify.start()
        self.addCleanup(notify.stop)
        self.posts: list = []
        # The runs the store held for the mission as each post went out.
        self.held: list = []
        self.runs = iter(["run_1", "run_2", "run_3", "run_4", "run_5"])

        async def post(_adapter, _profile, url, body, authorization=None):
            self.posts.append((url, body))
            self.held.append(research.runs_of(self.path, self.mission["id"]))
            return {"run_id": next(self.runs)} if url == "/v1/runs" else {}

        posting = mock.patch.object(plugin.outbox, "post", post)
        posting.start()
        self.addCleanup(posting.stop)

    def tearDown(self) -> None:
        research._forget(self.path, getattr(self, "mission", {}).get("id", ""))

    claim = MissionTest.claim

    def ask(self, action: str, body: Optional[dict] = None):
        request = FakeWeb.Request()
        request.headers = {}
        request.match_info = {"mission_id": self.mission["id"]}

        async def read():
            return body or {}

        request.json = read
        handler = route(self.app, f"{plugin.PREFIX}/research/{{mission_id}}/{action}")
        return asyncio.run(handler(request))

    def reach_scope(self) -> None:
        self.mission = research.create(self.path, None, "explain transformers")
        research._job(self.path, self.mission["id"])
        research.confirm_brief(
            self.path, self.mission["id"], {"goal": "G", "audience": "A developer", "format": "guide", "depth": "overview"}
        )
        research._job(self.path, self.mission["id"])

    def start(self) -> None:
        self.reach_scope()
        answer = self.ask("start", {"outline": ["Why attention", "Many heads"], "source_kinds": ["papers"]})
        self.assertEqual(answer.status, 200)

    def three_claims(self) -> None:
        for snippet in ("based solely on attention mechanisms", "dispensing with recurrence and convolutions", "Multi-head attention allows the model"):
            self.claim(snippet)

    def moved(self) -> list:
        return [mission_id for _p, mission_id, _r in research._check_watched()]

    def test_info_advertises_research_verify_where_research_is_ready(self) -> None:
        self.mission = {}
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(route(self.app, plugin.PREFIX + "/info")(request))
        self.assertTrue(answer.payload["research"]["ready"])
        self.assertIn("research_verify", answer.payload["features"])

    def test_start_posts_one_run_on_the_missions_session(self) -> None:
        self.start()
        self.assertEqual([url for url, _body in self.posts], ["/v1/runs"])
        self.assertEqual(self.posts[0][1]["session_id"], f"research-{self.mission['id']}")
        self.three_claims()
        # The watcher follows the run the start was answered with.
        self.adapter._run_statuses["run_1"] = {"run_id": "run_1", "status": "running"}
        self.assertEqual(self.moved(), [])
        self.adapter._run_statuses["run_1"]["status"] = "completed"
        self.assertEqual(self.moved(), [self.mission["id"]])
        self.assertEqual(research.mission(self.path, self.mission["id"])["stage"], "drafting")

    def test_retrying_a_failed_reading_posts_it_again_on_the_same_session(self) -> None:
        self.start()
        self.claim("based solely on attention mechanisms")
        research.finished_reading(self.path, self.mission["id"], "completed")
        self.assertIn("too few sources", research.mission(self.path, self.mission["id"])["error"])
        self.assertEqual(self.ask("retry").status, 200)
        self.assertEqual([url for url, _body in self.posts], ["/v1/runs", "/v1/runs"])
        self.assertEqual(self.posts[1][1]["session_id"], f"research-{self.mission['id']}")
        self.claim("dispensing with recurrence and convolutions")
        self.claim("Multi-head attention allows the model")
        # The retried run is the one followed, not the one that ended.
        self.adapter._run_statuses["run_1"] = {"run_id": "run_1", "status": "completed"}
        self.adapter._run_statuses["run_2"] = {"run_id": "run_2", "status": "running"}
        self.assertEqual(self.moved(), [])
        self.adapter._run_statuses["run_2"]["status"] = "completed"
        self.assertEqual(self.moved(), [self.mission["id"]])

    def test_removing_a_mission_stops_its_active_run(self) -> None:
        self.start()
        self.adapter._run_statuses["run_1"] = {"run_id": "run_1", "status": "running"}
        self.assertEqual(self.ask("remove").payload, {"object": "gots.research.removed", "removed": True})
        self.assertEqual([url for url, _body in self.posts], ["/v1/runs", "/v1/runs/run_1/stop"])
        self.assertIsNone(research.mission(self.path, self.mission["id"]))

    def test_removing_a_mission_whose_run_ended_stops_nothing(self) -> None:
        self.start()
        self.adapter._run_statuses["run_1"] = {"run_id": "run_1", "status": "completed"}
        self.ask("remove")
        self.assertEqual([url for url, _body in self.posts], ["/v1/runs"])

    def test_a_mission_mid_reading_at_the_old_schema_is_still_watched_after_the_upgrade(self) -> None:
        self.reach_scope()
        research.approve_scope(self.path, self.mission["id"], {"outline": ["Why attention"], "source_kinds": ["papers"]})
        self.three_claims()
        # The store as version 64 left it: the mission's one run on its own row.
        conn = sqlite3.connect(self.path)
        conn.execute("UPDATE research_missions SET run_id = 'run_old' WHERE id = ?", (self.mission["id"],))
        conn.execute("DROP TABLE IF EXISTS research_runs")
        conn.execute("PRAGMA user_version = 64")
        conn.commit()
        conn.close()
        research.resume(self.path)
        self.adapter._run_statuses["run_old"] = {"run_id": "run_old", "status": "running"}
        self.assertEqual(self.moved(), [])
        self.adapter._run_statuses["run_old"]["status"] = "completed"
        self.assertEqual(self.moved(), [self.mission["id"]])
        self.assertEqual(research.mission(self.path, self.mission["id"])["stage"], "drafting")

    def test_the_scope_gate_checks_a_verification_and_nothing_is_read_before_it(self) -> None:
        self.llm = FakeVerifyLlm()
        research.ctx = SimpleNamespace(llm=self.llm)
        self.mission = research.create(self.path, None, "Coffee KILLS you, every daily cup!!", "verify")
        args = {"claim": "A fact.", "url": "https://example.org/a", "title": "A", "kind": "articles",
                "snippet": "based solely on attention mechanisms", "stance": "for", "part": "p1"}
        with self.assertRaisesRegex(research.ResearchError, "isn't reading"):
            research.record(self.path, self.mission["id"], args, page_words)
        research._job(self.path, self.mission["id"])
        research.confirm_brief(
            self.path, self.mission["id"], {"restatement": "Daily coffee raises heart attack risk.", "parts": ["Risk rises"]}
        )
        with self.assertRaisesRegex(research.ResearchError, "isn't reading"):
            research.record(self.path, self.mission["id"], args, page_words)
        good = {"source_kinds": ["papers", "articles"], "strictness": "reputable"}
        for body in (
            {**good, "source_kinds": ["tv"]},
            {**good, "source_kinds": []},
            {"source_kinds": ["papers"]},
            {**good, "strictness": "strict"},
            {**good, "strictness": None},
        ):
            answer = self.ask("start", body)
            self.assertEqual(answer.status, 400, body)
            self.assertEqual(research.mission(self.path, self.mission["id"])["stage"], "scope")
        # Nothing is read while the gate refuses.
        self.assertEqual(self.posts, [])
        answer = self.ask("start", good)
        self.assertEqual(answer.status, 200)
        found = research.mission(self.path, self.mission["id"])
        self.assertEqual(
            (found["stage"], found["busy"], found["error"], found["source_kinds"], found["strictness"]),
            ("reading", None, None, ["papers", "articles"], "reputable"),
        )

    LOADED = "Coffee KILLS you: every daily cup is a heart attack waiting to happen!!"

    def start_verify(self) -> None:
        self.llm = FakeVerifyLlm()
        research.ctx = SimpleNamespace(llm=self.llm)
        self.mission = research.create(self.path, None, self.LOADED, "verify")
        research._job(self.path, self.mission["id"])
        research.confirm_brief(
            self.path,
            self.mission["id"],
            {
                "restatement": "Drinking coffee every day raises heart attack risk.",
                "parts": ["Coffee is drunk every day", "Heart attack risk rises"],
                "terms": ["every day"],
            },
        )
        answer = self.ask("start", {"source_kinds": ["papers"], "strictness": "reputable"})
        self.assertEqual(answer.status, 200)

    def lane_claim(self, lane: str, stance: Optional[str] = "supports", part: Optional[str] = "p1",
                   url: str = "https://example.org/a", title: str = "A") -> dict:
        args = {"claim": "A fact.", "url": url, "title": title, "kind": "papers",
                "snippet": "based solely on attention mechanisms", "stance": stance, "part": part}
        session = f"research-{self.mission['id']}" + (f"-{lane}" if lane else "")
        with mock.patch.object(research, "_fetch_words", page_words):
            return json.loads(research.handle(args, task_id=session))

    def statuses(self, **runs: str) -> None:
        for run_id, status in runs.items():
            self.adapter._run_statuses[run_id] = {"run_id": run_id, "status": status}

    def test_two_lanes_read_blind_and_the_mission_moves_on_once_both_stopped(self) -> None:
        self.start_verify()
        mission_id = self.mission["id"]
        sessions = [body["session_id"] for _url, body in self.posts]
        self.assertEqual([url for url, _body in self.posts], ["/v1/runs", "/v1/runs"])
        self.assertEqual(sessions, [f"research-{mission_id}-for", f"research-{mission_id}-against"])
        bodies = [body for _url, body in self.posts]
        for body, other in ((bodies[0], bodies[1]), (bodies[1], bodies[0])):
            said = json.dumps(body)
            # Neither lane sees the user's own wording, nor anything of the other lane.
            self.assertNotIn("KILLS", said)
            self.assertNotIn("waiting to happen", said)
            self.assertNotIn(other["session_id"], said)
            self.assertNotIn(other["instructions"], said)
            prompt = body["input"][0]["content"]
            for told in (
                "Drinking coffee every day raises heart attack risk.",
                "p1: Coffee is drunk every day",
                "p2: Heart attack risk rises",
                "every day",
                "research papers",
                "primary",
            ):
                self.assertIn(told, prompt)
        self.assertIn("true", bodies[0]["instructions"])
        self.assertIn("false", bodies[1]["instructions"])
        self.assertEqual(research.runs_of(self.path, mission_id), {"for": "run_1", "against": "run_2"})
        self.lane_claim("for")
        # One lane stopped does not move the mission.
        self.statuses(run_1="completed", run_2="running")
        self.assertEqual(self.moved(), [])
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], found["error"]), ("reading", None))
        self.statuses(run_2="completed")
        self.assertEqual(self.moved(), [mission_id])
        self.assertEqual(research.mission(self.path, mission_id)["stage"], "drafting")

    def test_a_verifications_claim_needs_a_stance_and_a_part_and_keeps_its_lane(self) -> None:
        self.start_verify()
        for stance, part, error in (
            (None, "p1", "stance must be one of: supports, refutes, context"),
            ("for", "p1", "stance must be one of: supports, refutes, context"),
            ("supports", None, "part must be one of: p1, p2"),
            ("supports", "p9", "part must be one of: p1, p2"),
        ):
            self.assertIn(error, self.lane_claim("for", stance, part).get("error", ""), (stance, part))
        # Only the mission's own lanes record claims.
        self.assertIn("error", self.lane_claim("", "supports", "p1"))
        self.assertEqual(research.mission(self.path, self.mission["id"])["claims"], 0)
        # Either lane may record any stance.
        self.assertEqual(self.lane_claim("against", "supports", "p2")["id"], "c1")
        self.assertEqual(self.lane_claim("for", "refutes", "p1")["id"], "c2")
        self.assertEqual(self.lane_claim("for", "context", "p2")["id"], "c3")
        claims = research.mission(self.path, self.mission["id"])["ledger"]["claims"]
        self.assertEqual(
            [(c["id"], c["stance"], c["part"], c["lane"]) for c in claims],
            [("c1", "supports", "p2", "against"), ("c2", "refutes", "p1", "for"), ("c3", "context", "p2", "for")],
        )

    def test_an_empty_reading_fails_with_the_web_search_hint(self) -> None:
        self.start_verify()
        self.statuses(run_1="completed", run_2="completed")
        self.assertEqual(self.moved(), [self.mission["id"]])
        found = research.mission(self.path, self.mission["id"])
        self.assertEqual(found["stage"], "reading")
        self.assertEqual(
            found["error"],
            "The researcher found too few sources to write from. Check that web search works on the host.",
        )
        self.assertEqual(self.notify.call_args_list[-1].args[0], "research_failed")
        # Both lanes completed, so Try again reads in both again.
        self.assertEqual(self.ask("retry").status, 200)
        self.assertEqual(
            [body["session_id"] for _url, body in self.posts[2:]],
            [f"research-{self.mission['id']}-for", f"research-{self.mission['id']}-against"],
        )

    def test_a_lane_that_broke_fails_the_reading_and_try_again_restarts_only_it(self) -> None:
        self.start_verify()
        mission_id = self.mission["id"]
        self.lane_claim("for", "supports", "p1")
        self.lane_claim("against", "refutes", "p2")
        self.statuses(run_1="completed", run_2="failed")
        self.assertEqual(self.moved(), [mission_id])
        found = research.mission(self.path, mission_id)
        self.assertEqual(
            (found["stage"], found["error"], found["claims"]),
            ("reading", "The researcher stopped before recording enough sources.", 2),
        )
        self.assertEqual(self.ask("retry").status, 200)
        self.assertEqual([body["session_id"] for _url, body in self.posts[2:]], [f"research-{mission_id}-against"])
        # The broken lane's run was let go of before its new one was posted, so the watcher can't
        # read the old run's end as the new reading's.
        self.assertEqual(self.held[-1], {"for": "run_1"})
        self.assertEqual(research.runs_of(self.path, mission_id), {"for": "run_1", "against": "run_3"})
        self.assertEqual(self.moved(), [])
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["error"], found["claims"]), (None, 2))
        self.statuses(run_3="completed")
        self.assertEqual(self.moved(), [mission_id])
        self.assertEqual(research.mission(self.path, mission_id)["stage"], "drafting")

    def test_a_lane_whose_run_vanished_fails_the_reading_and_try_again_restarts_it(self) -> None:
        self.start_verify()
        mission_id = self.mission["id"]
        self.lane_claim("for", "supports", "p1")
        self.lane_claim("against", "refutes", "p2")
        self.statuses(run_1="completed", run_2="running")
        self.assertEqual(self.moved(), [])
        # A host restart: the running lane's run is gone from Hermes's statuses.
        del self.adapter._run_statuses["run_2"]
        self.assertEqual(self.moved(), [mission_id])
        found = research.mission(self.path, mission_id)
        self.assertEqual(
            (found["stage"], found["error"], found["claims"]),
            ("reading", "The researcher stopped before recording enough sources.", 2),
        )
        self.assertEqual(research.ends_of(self.path, mission_id), {"for": "completed", "against": "interrupted"})
        self.assertEqual(self.ask("retry").status, 200)
        self.assertEqual([body["session_id"] for _url, body in self.posts[2:]], [f"research-{mission_id}-against"])

    def test_a_completed_lane_stays_completed_when_hermes_forgets_its_run(self) -> None:
        self.start_verify()
        mission_id = self.mission["id"]
        self.lane_claim("for", "supports", "p1")
        self.lane_claim("against", "refutes", "p2")
        with mock.patch.object(research, "UNSEEN_GRACE_S", 0.0):
            self.statuses(run_1="completed", run_2="running")
            self.assertEqual(self.moved(), [])
            # Hermes prunes a finished run's status after an hour, while the other lane still reads.
            del self.adapter._run_statuses["run_1"]
            self.assertEqual(self.moved(), [])
            self.statuses(run_2="completed")
            self.assertEqual(self.moved(), [mission_id])
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], found["error"]), ("drafting", None))
        self.assertEqual(research.ends_of(self.path, mission_id), {"for": "completed", "against": "completed"})

    def test_try_again_after_a_broken_lane_moves_on_once_the_restarted_lane_completes(self) -> None:
        self.start_verify()
        mission_id = self.mission["id"]
        self.lane_claim("for", "supports", "p1")
        self.lane_claim("against", "refutes", "p2")
        self.statuses(run_1="completed", run_2="running")
        self.assertEqual(self.moved(), [])
        del self.adapter._run_statuses["run_2"]
        self.assertEqual(self.moved(), [mission_id])
        self.assertEqual(research.ends_of(self.path, mission_id), {"for": "completed", "against": "interrupted"})
        # A restart later: Hermes lists no run at all.
        self.adapter._run_statuses.clear()
        research._seen.clear()
        self.assertEqual(self.ask("retry").status, 200)
        self.assertEqual([body["session_id"] for _url, body in self.posts[2:]], [f"research-{mission_id}-against"])
        with mock.patch.object(research, "UNSEEN_GRACE_S", 0.0):
            self.statuses(run_3="completed")
            self.assertEqual(self.moved(), [mission_id])
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], found["error"]), ("drafting", None))

    def test_a_lane_that_failed_to_start_does_not_leave_its_sibling_running_twice(self) -> None:
        count = {"runs": 0}

        async def post(_adapter, _profile, url, body, authorization=None):
            self.posts.append((url, body))
            if url != "/v1/runs":
                return {}
            count["runs"] += 1
            if count["runs"] == 2:
                raise plugin.outbox.StartError("busy", False)
            return {"run_id": f"run_{count['runs']}"}

        with mock.patch.object(plugin.outbox, "post", post):
            self.start_verify()
            mission_id = self.mission["id"]
            self.assertIn("Couldn't start the research", research.mission(self.path, mission_id)["error"])
            self.statuses(run_1="running")
            self.assertEqual(self.moved(), [])
            self.assertEqual(self.ask("retry").status, 200)
            sessions = [body["session_id"] for url, body in self.posts if url == "/v1/runs"]
            self.assertEqual(
                sessions, [f"research-{mission_id}-for", f"research-{mission_id}-against", f"research-{mission_id}-against"]
            )
            self.assertEqual(research.runs_of(self.path, mission_id), {"for": "run_1", "against": "run_3"})
            self.statuses(run_3="running")
            self.posts.clear()
            self.ask("remove")
        self.assertEqual(sorted(url for url, _body in self.posts), ["/v1/runs/run_1/stop", "/v1/runs/run_3/stop"])

    def search(self, session: str, query, tool: str = "web_search"):
        return research.before_tool(tool_name=tool, args={"query": query}, task_id=session, session_id=session)

    def test_each_lanes_web_search_queries_are_recorded_capped_and_read_back_with_the_mission(self) -> None:
        self.start_verify()
        mission_id = self.mission["id"]
        lane = {name: f"research-{mission_id}-{name}" for name in ("for", "against")}
        self.assertIsNone(self.search(lane["for"], "  coffee heart attack cohort  "))
        self.assertIsNone(self.search(lane["against"], "coffee no cardiac risk meta-analysis"))
        self.assertIsNone(self.search(lane["for"], "coffee myocardial infarction"))
        # A repeat in a lane is kept once; the same words in the other lane are that lane's own.
        self.search(lane["for"], "coffee heart attack cohort")
        self.search(lane["against"], "coffee heart attack cohort")
        # Nothing that isn't a query is kept, and nothing from another tool.
        for query in ("", "   ", None, 42, ["a"]):
            self.assertIsNone(self.search(lane["for"], query))
        self.search(lane["for"], "coffee tea", tool="web_extract")
        # A blocked tool is still blocked, and leaves no search.
        self.assertEqual(self.search(lane["for"], "rm -rf /", tool="terminal")["action"], "block")
        found = research.mission(self.path, mission_id)
        self.assertEqual(
            found["searches"],
            {
                "for": ["coffee heart attack cohort", "coffee myocardial infarction"],
                "against": ["coffee no cardiac risk meta-analysis", "coffee heart attack cohort"],
            },
        )
        # A long query is cut to its first 300 characters, and a lane keeps at most 40 queries.
        self.search(lane["against"], "x" * 500)
        for n in range(60):
            self.search(lane["for"], f"query {n}")
        found = research.mission(self.path, mission_id)
        self.assertEqual(found["searches"]["against"][-1], "x" * 300)
        self.assertEqual(len(found["searches"]["for"]), 40)
        self.assertEqual(found["searches"]["for"][:3], ["coffee heart attack cohort", "coffee myocardial infarction", "query 0"])
        # Try again keeps what a restarted lane searched: those searches were really made.
        self.lane_claim("for")
        self.statuses(run_1="completed", run_2="failed")
        self.moved()
        self.assertEqual(self.ask("retry").status, 200)
        self.assertEqual(len(research.mission(self.path, mission_id)["searches"]["against"]), 3)
        # A fresh reading starts with no searches, and removing the mission takes them with it.
        research._clear(self.path, mission_id)
        self.assertEqual(research.mission(self.path, mission_id)["searches"], {"for": [], "against": []})
        self.search(lane["for"], "coffee again")
        self.ask("remove")
        conn = sqlite3.connect(self.path)
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM research_searches").fetchone()[0], 0)
        finally:
            conn.close()

    def test_a_learn_researcher_and_a_chat_keep_no_searches(self) -> None:
        self.start()
        self.assertIsNone(self.search(f"research-{self.mission['id']}", "how attention works"))
        self.assertIsNone(self.search("gots-chat", "how attention works"))
        self.assertNotIn("searches", research.mission(self.path, self.mission["id"]))
        conn = sqlite3.connect(self.path)
        try:
            # The read shows no trail for a Learn mission, so the store is the only place to look.
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            count = conn.execute("SELECT COUNT(*) FROM research_searches").fetchone()[0] if "research_searches" in tables else 0
            self.assertEqual(count, 0)
        finally:
            conn.close()

    def read_verify(self, llm: Optional[FakeVerdictLlm] = None) -> str:
        self.start_verify()
        self.llm = llm or FakeVerdictLlm()
        research.ctx = SimpleNamespace(llm=self.llm)
        mission_id = self.mission["id"]
        # The researchers' own stances: the against lane backs p1, and the for lane calls c4 context.
        self.lane_claim("for", "supports", "p1", "https://www.example.org/cohort", "Cohort study")
        self.lane_claim("against", "supports", "p1", "https://news.other.com/trial", "Trial report")
        self.lane_claim("for", "refutes", "p2", "https://a.org/review", "Review")
        self.lane_claim("against", "context", "p2", "https://b.org/background", "Background")
        self.statuses(run_1="completed", run_2="completed")
        self.assertEqual(self.moved(), [mission_id])
        self.assertEqual(research.mission(self.path, mission_id)["stage"], "drafting")
        return mission_id

    def deliver_verify(self, llm: Optional[FakeVerdictLlm] = None) -> dict:
        mission_id = self.read_verify(llm)
        research._job(self.path, mission_id)
        return research.mission(self.path, mission_id)

    def test_a_claim_from_paste_to_verdict(self) -> None:
        before = research._now()
        found = self.deliver_verify()
        after = research._now()
        mission_id = found["id"]
        self.assertEqual((found["stage"], found["formats"], found["error"]), ("delivered", ["verdict"], None))

        # One judge call, on the profile's own model, blind to the user's wording, the researchers'
        # stances and their lanes.
        judged = [c for c in self.llm.calls if c["purpose"] == "gots.research.verdict"]
        self.assertEqual(len(judged), 1)
        self.assertNotIn("model", judged[0])
        said = " ".join((judged[0]["system_prompt"], judged[0]["instructions"], judged[0]["input"][0]["text"])).lower()
        told = set(re.findall(r"[a-z]+", "Drinking coffee every day raises heart attack risk.".lower()))
        for word in set(re.findall(r"[a-z]+", self.LOADED.lower())) - told:
            if len(word) > 3:
                self.assertNotIn(word, said)
        data = judged[0]["input"][0]["text"]
        for hidden in ("stance", "lane", "supports", "refutes", "context", "against", "for:"):
            self.assertNotIn(hidden, data.lower())
        for shown in (
            "Drinking coffee every day raises heart attack risk.",
            "p1: Coffee is drunk every day",
            "p2: Heart attack risk rises",
            "Take literally: every day",
            "[c1]",
            "[c4]",
            "Cohort study",
            "https://www.example.org/cohort",
            "based solely on attention mechanisms",
        ):
            self.assertIn(shown, data)

        # The tags kept are the judge's, less any naming a claim, a part or a stance the mission lacks.
        out = found["outputs"]["verdict"]
        self.assertEqual(
            out["tags"],
            [
                {"claim": "c1", "part": "p1", "stance": "supports"},
                {"claim": "c2", "part": "p1", "stance": "supports"},
                {"claim": "c3", "part": "p2", "stance": "refutes"},
                {"claim": "c4", "part": "p2", "stance": "context"},
            ],
        )
        # p1 is backed by two sites; p2 is refuted by one: some of it is supported.
        self.assertEqual(out["verdict"]["label"], "partly_supported")
        self.assertEqual(out["verdict"], research.verdict(found["parts"], found["ledger"], out["tags"]))
        self.assertEqual(found["verdict"], out["verdict"])
        self.assertEqual(
            out["change"],
            [[{"text": "A trial that tracked daily drinkers would settle it.", "cites": ["c1"]}],
             [{"text": "Nobody has looked at it.", "flagged": True}]],
        )
        self.assertTrue(before <= out["checked_at"] <= after)
        self.assertEqual([r["reason"] for r in found["revisions"]], ["first"])
        self.assertEqual(found["revisions"][0]["outputs"]["verdict"], out)
        self.assertEqual(self.notify.call_args_list[-1].args[0], "research_done")
        self.assertEqual(self.notify.call_args_list[-1].kwargs.get("title"), found["title"])

    def test_a_judge_that_tags_nothing_fails_the_step(self) -> None:
        mission_id = self.read_verify(FakeVerdictLlm(tags=[{"part": "p1", "claims": [{"claim": "c9", "stance": "supports"}]}]))
        with self.assertRaisesRegex(research.ResearchError, "^The judge tagged nothing.$") as failed:
            research._job(self.path, mission_id)
        self.assertEqual(failed.exception.status, 502)
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], found["formats"]), ("drafting", []))
        self.assertNotIn("verdict", found["outputs"])

    def test_a_delivered_label_does_not_move_when_the_rule_changes(self) -> None:
        found = self.deliver_verify()
        self.assertEqual(found["verdict"]["label"], "partly_supported")
        with mock.patch.object(research, "verdict", lambda *_: {"label": "refuted"}):
            again = research.mission(self.path, found["id"])
        self.assertEqual(again["verdict"]["label"], "partly_supported")
        self.assertEqual(again["outputs"]["verdict"]["verdict"]["label"], "partly_supported")

    def test_a_verification_has_no_other_formats_follow_ups_or_rewrite(self) -> None:
        found = self.deliver_verify()
        with self.assertRaisesRegex(research.ResearchError, "one format, the verdict"):
            research.make_format(self.path, found["id"], "quiz")
        with self.assertRaisesRegex(research.ResearchError, "Learn & understand"):
            research.followup(self.path, found["id"], {"questions": ["Why?"]})
        with self.assertRaisesRegex(research.ResearchError, "Only a Learn"):
            research.rewrite(self.path, found["id"], {})
        # No follow-up questions are asked for.
        self.assertNotIn("gots.research.suggest", [c["purpose"] for c in self.llm.calls])
        after = research.mission(self.path, found["id"])
        self.assertEqual((after["suggestions"], after["formats"], after["stage"]), ([], ["verdict"], "delivered"))

    def test_removing_a_verification_stops_both_runs(self) -> None:
        self.start_verify()
        self.statuses(run_1="running", run_2="running")
        self.assertEqual(self.ask("remove").payload, {"object": "gots.research.removed", "removed": True})
        self.assertEqual(
            sorted(url for url, _body in self.posts[2:]), ["/v1/runs/run_1/stop", "/v1/runs/run_2/stop"]
        )


if __name__ == "__main__":
    unittest.main()
