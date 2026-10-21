"""Research missions: the brief, the Scope Gate, the ledger and writing from it.

Run: python3 -m unittest plugin.tests.test_research -v
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace

from plugin import research

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
        self.path = Path(self.dir.name) / "memento.db"
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
        # The store sits in the profile's memento folder, beside Hermes's own state.db.
        self.path = Path(self.dir.name) / "memento" / "memento.db"
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
        self.assertIsNone(research.before_tool(tool_name="terminal", task_id="memento-chat"))


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
        self.path = Path(self.dir.name) / "memento.db"
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


if __name__ == "__main__":
    unittest.main()
