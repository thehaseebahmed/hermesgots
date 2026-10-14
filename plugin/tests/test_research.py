"""Research missions: the brief, the Scope Gate, the ledger and writing from it.

Run: python3 -m unittest plugin.tests.test_research -v
"""

from __future__ import annotations

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

    def test_questions_it_missed_are_read_for_and_added_to_what_it_made(self) -> None:
        found = self.deliver()
        # What it still leaves open, without what the outline already covers or repeats.
        self.assertEqual(found["suggestions"], ["How is it trained?"])
        quizzes = sum(1 for call in self.llm.calls if call["purpose"].endswith(".quiz"))

        found = research.followup(self.path, found["id"], {"questions": ["How is it trained?", " ", "why attention"]})
        self.assertEqual(found["stage"], "reading")
        self.assertEqual(found["outline"], ["Why attention", "Many heads", "How is it trained?"])
        self.assertEqual((found["written"], found["suggestions"], found["claims"]), (2, [], 3))
        self.assertEqual([r["questions"] for r in found["followups"]], [["How is it trained?"]])
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
        self.assertEqual((found["stage"], found["formats"]), ("delivered", ["guide", "quiz"]))
        sections = found["outputs"]["guide"]["sections"]
        self.assertEqual(len(sections), 3)
        self.assertNotIn("question", sections[1])
        self.assertEqual(sections[2]["question"], "How is it trained?")
        section_call = [c for c in self.llm.calls if c["purpose"].endswith(".section")][-1]
        self.assertIn("answers the reader's question: How is it trained?", section_call["instructions"])
        # The quiz was written again from the grown ledger.
        self.assertEqual(sum(1 for c in self.llm.calls if c["purpose"].endswith(".quiz")), quizzes + 1)
        self.assertEqual(self.told()[-1], ("research_done", "How transformers work"))

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


if __name__ == "__main__":
    unittest.main()
