"""A literature review: the brief and the Scope Gate, the search folded and counted, the screening,
what is read of each paper, the quote check, the synthesis and the reference list.

The index is a fixture (``scholar.search`` patched), the model is ``FakeLlm`` and the open copies
are a dict, so nothing here reaches a network or a model.

Run: python3 -m unittest plugin.tests.test_literature -v
"""

from __future__ import annotations

import asyncio
import itertools
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest import mock

import plugin
from plugin import research, scholar
from plugin.store import db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

FILLER = "The methods are described in the sections that follow, with the measures and the analysis. " * 120
P1_TEXT = (
    "<html><body><h1>Sleep loss and working memory</h1><p>We tested whether one night without sleep "
    "impairs working memory. This was a randomised controlled trial. Sixty healthy adults were "
    "assigned to a night of sleep or a night awake.</p><p>" + FILLER + "</p><p>Accuracy on the "
    "<i>n-back</i> task fell by 12% after sleep deprivation. Reaction times on every block slowed "
    "in the deprived group. The sample was small and drawn from one university.</p></body></html>"
)
A2 = "A 30-minute nap restored recall to baseline in 40 students. We ran a survey-based comparison."
A6 = "We review 14 studies of total sleep deprivation. Most included studies were small."
A7 = "Restricting sleep to four hours did not change working memory accuracy in 25 adults."


def paper(title: str, doi: str = "", **fields):
    return {
        "title": title, "authors": ["Ada Okafor", "Lin Wei"], "more_authors": 0, "year": 2021, "venue": "Sleep",
        "doi": doi, "url": f"https://doi.org/{doi}" if doi else f"https://index.org/{title.replace(' ', '-')}",
        "preprint": False, "abstract": "", "text_urls": [], **fields,
    }


P1 = paper("Sleep loss and working memory: a trial", "10.1/a", abstract="One night awake.", text_urls=["https://open.org/p1"])
P2 = paper("Napping restores recall", "10.1/b", preprint=True, abstract=A2, text_urls=["https://open.org/p2.pdf"])
P3 = paper("Sleep in mice", "10.1/c", abstract="Mice were kept awake.")
P4 = paper("Caffeine markets", "10.1/d", abstract="Prices of coffee.")
P5 = paper("A cohort of shift workers")
P6 = paper("Total sleep deprivation: a review", "10.1/f", abstract=A6)
P7 = paper("Sleep restriction and attention", "10.1/g", abstract=A7)
P8 = paper("Never reached", "10.1/h", abstract="Later in the list.")
# The first query's papers, then the second's, which finds the first paper again.
FOUND = {"sleep working memory": [P1, P3, P5, P7], "nap recall": [P2, dict(P1), P4, P6, P8]}
PAGES = {"https://open.org/p1": " ".join(research._page_text(P1_TEXT.encode(), "text/html").split())}

EXTRACTS = {
    "Sleep loss and working memory": {
        "question": {"value": "Does a night without sleep impair working memory?", "quote": "We tested whether one night without sleep impairs working memory."},
        "design": {"value": "trial", "quote": "This was a randomised controlled trial."},
        "sample": {"value": "Sixty healthy adults.", "quote": "Sixty healthy adults were assigned"},
        "findings": [
            {"value": "Accuracy fell by 12%.", "quote": "Accuracy on the n-back task fell by 12% after sleep deprivation."},
            # A passage split by an ellipsis stands when both halves are in the text.
            {"value": "Reaction times slowed.", "quote": "Reaction times … slowed in the deprived group."},
            # A quote the text doesn't hold: the field is dropped, whatever the model says.
            {"value": "Memory improved.", "quote": "Memory improved markedly after deprivation."},
        ],
        "limitations": [{"value": "A small, single-site sample.", "quote": "The sample was small and drawn from one university."}],
    },
    "Napping restores recall": {
        "question": {"value": "", "quote": ""},
        "design": {"value": "survey", "quote": "survey"},
        "sample": {"value": "", "quote": ""},
        "findings": [{"value": "A short nap restored recall.", "quote": "A 30-minute nap restored recall to baseline in 40 students."}],
        "limitations": [],
    },
    "Total sleep deprivation": {
        "question": {"value": "", "quote": ""},
        "design": {"value": "review", "quote": "We review 14 studies of total sleep deprivation."},
        "sample": {"value": "", "quote": ""},
        "findings": [{"value": "Deprivation halves memory.", "quote": "Sleep deprivation halves working memory capacity."}],
        "limitations": [{"value": "Small studies.", "quote": "Most included studies were small."}],
    },
    "Sleep restriction and attention": {
        "question": {"value": "", "quote": ""},
        "design": {"value": "", "quote": ""},
        "sample": {"value": "", "quote": ""},
        "findings": [{"value": "Four hours of sleep changed nothing.", "quote": A7}],
        "limitations": [],
    },
}
SYNTHESIS = {
    "themes": [
        {
            "title": "Working memory after sleep loss",
            "claims": ["c4", "c99"],
            "paragraphs": ["Accuracy fell after a night without sleep. [c4] One study found no change. [c8] Smith et al. (2019) agree."],
        },
        {"title": "Recovery", "claims": ["c7"], "paragraphs": ["A nap restored recall. [c7]"]},
        {"title": "Nothing behind it", "claims": ["c99"], "paragraphs": ["Nothing. [c99]"]},
    ],
    "disagreements": [
        {"a": "c4", "b": "c8", "about": "Whether sleep loss lowers accuracy."},
        {"a": "c8", "b": "c4", "about": "The same pair again."},
        {"a": "c4", "b": "c5", "about": "Two findings of one paper."},
        {"a": "c4", "b": "c7", "about": "Findings under different themes."},
        {"a": "c4", "b": "c99", "about": "A claim the ledger lacks."},
    ],
    "gaps": ["The studies were small. [c10]"],
    # A model that types a reference list anyway: nothing reads it.
    "references": ["Smith, J. (2019). A made-up paper. Journal of Nothing."],
}


class FakeLlm:
    def __init__(self) -> None:
        self.calls: list = []
        self.fail_extract_of: Optional[str] = None
        self.screens = {"Sleep in mice": ("exclude", 1), "Caffeine markets": ("exclude", 0), "A cohort of shift workers": ("unsure", 0)}

    def purposes(self) -> list:
        return [call["purpose"].rsplit(".", 1)[-1] for call in self.calls]

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        purpose = kwargs["purpose"].rsplit(".", 1)[-1]
        text = kwargs["input"][0]["text"]
        if purpose == "brief":
            parsed = {
                "title": "Sleep loss and working memory",
                "goal": "What does research say about sleep deprivation and working memory?",
                "field": "Cognitive psychology",
                "from_year": 2018,
                "to_year": 0,
                "criteria": ["Human participants", "Measures working memory", "", "Human participants"],
                "queries": ["sleep working memory", "nap recall"],
            }
        elif purpose == "screen":
            title = next(line[7:] for line in text.splitlines() if line.startswith("Title: "))
            verdict, fails = self.screens.get(title, ("include", 0))
            parsed = {"verdict": verdict, "fails": fails, "reason": f"Because of {title}."}
        elif purpose == "extract":
            key = next((key for key in EXTRACTS if key in text), None)
            if key and key == self.fail_extract_of:
                self.fail_extract_of = None
                raise RuntimeError("the model is down")
            blank = {"value": "", "quote": ""}
            nothing = {"question": blank, "design": blank, "sample": blank, "findings": [], "limitations": []}
            parsed = EXTRACTS.get(key, nothing)
        else:
            parsed = SYNTHESIS
        return SimpleNamespace(parsed=parsed, text="")


class LiteratureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "gots.db"
        self.llm = FakeLlm()
        research.ctx = SimpleNamespace(llm=self.llm)
        self.searches: list = []

        def search(query, from_year=None, to_year=None, preprints=True, key=None):
            self.searches.append((query, from_year, to_year, preprints, key))
            return [dict(found) for found in FOUND[query]]

        for target, name, value in (
            (research.push, "notify", mock.MagicMock()),
            (scholar, "search", search),
            (scholar, "api_key", lambda: None),
            (research, "_fetch_text", lambda url: PAGES.get(url)),
        ):
            patch = mock.patch.object(target, name, value)
            setattr(self, name, patch.start())
            self.addCleanup(patch.stop)
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(setattr, research, "ctx", None)

    def told(self) -> list:
        return [call.args[0] for call in self.notify.call_args_list]

    def at_scope(self) -> str:
        found = research.create(self.path, None, "what does research say about sleep and working memory?", "literature")
        research._job(self.path, found["id"])
        research.confirm_brief(
            self.path, found["id"],
            {"goal": "What does sleep loss do to working memory?", "field": "Psychology", "from_year": 2018,
             "criteria": ["Human participants", "Measures working memory"]},
        )
        return found["id"]

    def reading(self, cap: int = 5) -> str:
        mission_id = self.at_scope()
        research.approve_scope(self.path, mission_id, {"queries": ["sleep working memory", "nap recall"], "cap": cap, "preprints": True})
        return mission_id

    def test_the_question_is_read_back_with_its_criteria_and_confirmed_without_an_outline_call(self) -> None:
        found = research.create(self.path, None, "what does research say about sleep and working memory?", "literature")
        self.assertEqual((found["type"], found["format"], found["busy"]), ("literature", "review", "brief"))
        research._job(self.path, found["id"])
        found = research.mission(self.path, found["id"])
        self.assertEqual((found["stage"], found["busy"], found["title"]), ("brief", None, "Sleep loss and working memory"))
        # Blank and repeated lines are dropped; a year of 0 is no limit; nothing is searched yet.
        self.assertEqual(
            found["review"],
            {"field": "Cognitive psychology", "from_year": 2018, "to_year": None,
             "criteria": ["Human participants", "Measures working memory"],
             "queries": ["sleep working memory", "nap recall"], "cap": 25, "preprints": True},
        )
        self.assertEqual(self.told(), ["research_brief"])

        base = {"goal": "What does sleep loss do to working memory?", "criteria": ["Humans"]}
        for body, why in (
            ({**base, "goal": " "}, "question is required"),
            ({**base, "criteria": ["", " "]}, "1 to 6 inclusion criteria"),
            ({**base, "criteria": [str(i) for i in range(7)]}, "1 to 6 inclusion criteria"),
            ({**base, "from_year": 1492}, "first year must be a year"),
            ({**base, "from_year": "2018"}, "first year must be a year"),
            ({**base, "from_year": 2020, "to_year": 2019}, "after the last"),
        ):
            with self.assertRaisesRegex(research.ResearchError, why):
                research.confirm_brief(self.path, found["id"], body)

        found = research.confirm_brief(
            self.path, found["id"], {**base, "field": " Psychology ", "from_year": 2019, "to_year": 2024, "criteria": [" Humans ", "humans", "Adults"]}
        )
        self.assertEqual((found["stage"], found["busy"]), ("scope", None))
        # The proposed queries are the Scope Gate's outline, and no model call proposed them.
        self.assertEqual(found["outline"], ["sleep working memory", "nap recall"])
        self.assertEqual(
            (found["review"]["field"], found["review"]["from_year"], found["review"]["to_year"], found["review"]["criteria"]),
            ("Psychology", 2019, 2024, ["Humans", "Adults"]),
        )
        self.assertEqual(found["source_kinds"], ["papers"])
        self.assertEqual(self.llm.purposes(), ["brief"])
        self.assertEqual(self.told(), ["research_brief", "research_scope"])
        self.assertEqual(self.searches, [])

    def test_the_scope_gate_takes_the_queries_the_cap_and_preprints(self) -> None:
        mission_id = self.at_scope()
        good = {"queries": ["sleep working memory"], "cap": 25, "preprints": False}
        for body, why in (
            ({**good, "queries": []}, "1 to 6 search queries"),
            ({**good, "queries": [str(i) for i in range(7)]}, "1 to 6 search queries"),
            ({**good, "cap": 4}, "5 to 40 papers"),
            ({**good, "cap": 41}, "5 to 40 papers"),
            ({**good, "cap": True}, "5 to 40 papers"),
            ({**good, "preprints": "yes"}, "true or false"),
        ):
            with self.assertRaisesRegex(research.ResearchError, why):
                research.approve_scope(self.path, mission_id, body)
        self.assertEqual(self.searches, [])
        found = research.approve_scope(self.path, mission_id, {**good, "queries": [" nap recall ", "Nap Recall", "sleep working memory"]})
        self.assertEqual((found["stage"], found["outline"]), ("reading", ["nap recall", "sleep working memory"]))
        self.assertEqual((found["review"]["cap"], found["review"]["preprints"]), (25, False))
        # Approving reads nothing by itself: the reading is the job's.
        self.assertEqual(self.searches, [])

    def test_a_review_from_the_search_to_the_delivered_review(self) -> None:
        mission_id = self.reading()
        research._job(self.path, mission_id)
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], found["error"], found["formats"]), ("delivered", None, ["review"]))
        # Each query ran once, with the confirmed years and the Scope Gate's preprints.
        self.assertEqual(self.searches, [("sleep working memory", 2018, None, True, None), ("nap recall", 2018, None, True, None)])

        funnel = found["funnel"]
        self.assertEqual(
            {key: funnel[key] for key in ("found", "duplicates", "screened", "included", "unsure", "excluded", "unscreened")},
            {"found": 8, "duplicates": 1, "screened": 7, "included": 5, "unsure": 1,
             "excluded": {"Human participants": 1, "Off topic": 1}, "unscreened": 1},
        )
        self.assertEqual(funnel["index"], "OpenAlex")
        self.assertFalse(funnel["keyed"])

        sources = {source["id"]: source for source in found["ledger"]["sources"]}
        self.assertEqual(
            [(s["title"], s["screening"], s["evidence_level"]) for s in sources.values()],
            [
                ("Sleep loss and working memory: a trial", "include", "full"),
                # Its open copy is a PDF, which nothing here reads: abstract only, never a failure.
                ("Napping restores recall", "include", "abstract"),
                ("Sleep in mice", "exclude", None),
                ("A cohort of shift workers", "unsure", "metadata"),
                ("Caffeine markets", "exclude", None),
                ("Sleep restriction and attention", "include", "abstract"),
                ("Total sleep deprivation: a review", "include", "abstract"),
                ("Never reached", "unscreened", None),
            ],
        )
        self.assertEqual((sources["s3"]["screen_fails"], sources["s5"]["screen_fails"]), ("Human participants", "Off topic"))
        self.assertEqual((sources["s1"]["dropped"], sources["s2"]["dropped"], sources["s7"]["dropped"]), (1, 1, 1))
        self.assertEqual((sources["s2"]["preprint"], sources["s1"]["authors"], sources["s1"]["year"]), (True, ["Ada Okafor", "Lin Wei"], 2021))
        # A mission's sources are the papers it included.
        self.assertEqual(found["found"], 5)

        claims = [(c["id"], c["source"], c["field"]) for c in found["ledger"]["claims"]]
        self.assertEqual(
            claims,
            [
                ("c1", "s1", "question"), ("c2", "s1", "design"), ("c3", "s1", "sample"), ("c4", "s1", "finding"),
                ("c5", "s1", "finding"), ("c6", "s1", "limitation"), ("c7", "s2", "finding"), ("c8", "s6", "finding"),
                ("c9", "s7", "design"), ("c10", "s7", "limitation"),
            ],
        )
        self.assertTrue(all(c["confidence"] == "supported" for c in found["ledger"]["claims"]))
        # A paper read at metadata only made no model call, and the unscreened one none at all.
        self.assertEqual(self.llm.purposes().count("screen"), 7)
        self.assertEqual(self.llm.purposes().count("extract"), 4)

        review = found["outputs"]["review"]
        self.assertEqual(
            [(t["id"], t["title"], t["claims"], t["papers"], t["full"]) for t in review["themes"]],
            [("t1", "Working memory after sleep loss", ["c4", "c8"], 2, 1), ("t2", "Recovery", ["c7"], 1, 0)],
        )
        # A sentence that names a paper instead of citing a claim is flagged, like any uncited one.
        uncited = review["themes"][0]["paragraphs"][0][2:]
        self.assertEqual("".join(span["text"] for span in uncited), " Smith et al. (2019) agree.")
        self.assertTrue(all(span.get("flagged") for span in uncited))
        self.assertEqual(
            review["disagreements"], [{"a": "c4", "b": "c8", "theme": "t1", "about": "Whether sleep loss lowers accuracy."}]
        )
        self.assertEqual(review["gaps"], [[{"text": "The studies were small.", "cites": ["c10"]}]])
        self.assertEqual((review["read"], review["dropped"]), ({"full": 1, "abstract": 3, "metadata": 1}, 3))
        self.assertEqual(review["method"]["index"], "OpenAlex")
        self.assertEqual(review["funnel"], funnel)
        themes = {c["id"]: c.get("theme") for c in found["ledger"]["claims"]}
        self.assertEqual((themes["c4"], themes["c8"], themes["c7"], themes["c1"]), ("t1", "t1", "t2", None))

        # The reference list is the index's metadata for the included papers and nothing a model typed.
        self.assertEqual([r["source"] for r in review["references"]], ["s1", "s2", "s4", "s6", "s7"])
        self.assertEqual(
            review["references"][1]["text"],
            "Ada Okafor, Lin Wei (2021). Napping restores recall. Sleep. Preprint. https://doi.org/10.1/b",
        )
        self.assertNotIn("Smith", " ".join(r["text"] for r in review["references"]))
        self.assertNotIn("made-up", str(review["references"]))

        # Only short quotes stay: the abstracts and addresses the reading worked from are gone.
        rows = research._papers(self.path, mission_id)
        self.assertTrue(all(row["abstract"] is None and row["text_urls"] is None for row in rows))
        self.assertEqual([r["reason"] for r in found["revisions"]], ["first"])
        self.assertEqual(self.told(), ["research_brief", "research_scope", "research_done"])

    def test_what_the_model_is_shown_never_includes_a_reference_to_type(self) -> None:
        mission_id = self.reading()
        research._job(self.path, mission_id)
        synthesis = next(call for call in self.llm.calls if call["purpose"].endswith("synthesis"))
        text = synthesis["input"][0]["text"]
        self.assertIn("Paper s1 (read in full), 2021:", text)
        self.assertIn("Paper s2 (abstract only), 2021:", text)
        for hidden in ("Ada Okafor", "Napping restores recall", "10.1/a", "Sleep."):
            self.assertNotIn(hidden, text)

    def test_a_restart_mid_paper_reads_that_paper_again_and_no_other(self) -> None:
        mission_id = self.reading()
        self.llm.fail_extract_of = "Napping restores recall"
        with self.assertRaisesRegex(research.ResearchError, "model call failed"):
            research._job(self.path, mission_id)
        found = research.mission(self.path, mission_id)
        self.assertEqual(found["stage"], "reading")
        self.assertEqual([c["source"] for c in found["ledger"]["claims"]], ["s1"] * 6)
        levels = {s["id"]: s["evidence_level"] for s in found["ledger"]["sources"]}
        self.assertEqual((levels["s1"], levels["s2"]), ("full", None))

        research._job(self.path, mission_id)
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], len(found["ledger"]["claims"])), ("delivered", 10))
        # The search and the screening were not run again, and the first paper was read once.
        self.assertEqual(len(self.searches), 2)
        self.assertEqual(self.llm.purposes().count("screen"), 7)
        extracts = [c["input"][0]["text"] for c in self.llm.calls if c["purpose"].endswith("extract")]
        self.assertEqual(sum("Sleep loss and working memory" in text for text in extracts), 1)
        self.assertEqual(sum("Napping restores recall" in text for text in extracts), 2)

    def test_a_copy_that_cannot_be_fetched_lands_at_abstract_only(self) -> None:
        def broken(url):
            raise OSError("connection reset")

        with mock.patch.object(research, "_fetch_text", broken):
            mission_id = self.reading()
            research._job(self.path, mission_id)
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], found["error"]), ("delivered", None))
        self.assertEqual(found["ledger"]["sources"][0]["evidence_level"], "abstract")
        # Read at its abstract, the first paper's full-text quotes are not there to be found.
        self.assertEqual(found["outputs"]["review"]["read"], {"full": 0, "abstract": 4, "metadata": 1})

    def test_a_short_landing_page_is_not_the_papers_text(self) -> None:
        row = {"abstract": "One night awake.", "text_urls": '["https://open.org/abs", "https://open.org/p1"]'}
        pages = {"https://open.org/abs": "Sleep loss and working memory. Abstract: one night awake. Download PDF.", **PAGES}
        self.assertEqual(research._paper_text(row, pages.get)[0], "full")
        self.assertEqual(research._paper_text(row, {"https://open.org/abs": pages["https://open.org/abs"]}.get), ("abstract", "One night awake."))
        self.assertEqual(research._paper_text({"abstract": " ", "text_urls": None}, pages.get), ("metadata", ""))

    def test_too_few_papers_with_a_checked_finding_fail_the_reading(self) -> None:
        self.llm.screens.update({"Napping restores recall": ("exclude", 2), "Sleep restriction and attention": ("exclude", 2)})
        mission_id = self.reading()
        with self.assertRaisesRegex(research.ResearchError, "Too few papers to review: 4 passed screening and 1 gave"):
            research._job(self.path, mission_id)
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], found["funnel"]["excluded"]), ("reading", {"Human participants": 1, "Off topic": 1, "Measures working memory": 2}))
        self.assertNotIn("synthesis", self.llm.purposes())

    def test_an_index_that_refuses_fails_the_reading_in_its_own_words(self) -> None:
        def refused(*_args, **_kwargs):
            raise scholar.IndexError_("OpenAlex's free daily budget for this network is used up.")

        mission_id = self.reading()
        with mock.patch.object(scholar, "search", refused):
            with self.assertRaisesRegex(research.ResearchError, "free daily budget") as failed:
                research._job(self.path, mission_id)
        self.assertEqual(failed.exception.status, 502)
        found = research.mission(self.path, mission_id)
        self.assertEqual((found["stage"], found["funnel"], found["found"]), ("reading", None, 0))
        # Try again searches from the start.
        research._job(self.path, mission_id)
        self.assertEqual(research.mission(self.path, mission_id)["stage"], "delivered")

    def test_a_mission_removed_mid_read_stops_between_two_papers(self) -> None:
        mission_id = self.reading()
        real = self.llm.complete_structured

        def remove_on_first_screen(**kwargs):
            if kwargs["purpose"].endswith("screen"):
                research.remove(self.path, mission_id)
            return real(**kwargs)

        self.llm.complete_structured = remove_on_first_screen
        research._job(self.path, mission_id)
        self.assertIsNone(research.mission(self.path, mission_id))
        self.assertEqual(self.llm.purposes().count("screen"), 1)
        self.assertEqual(research._papers(self.path, mission_id), [])

    def test_a_review_has_one_format_and_takes_no_claims_from_a_tool(self) -> None:
        mission_id = self.reading()
        with self.assertRaisesRegex(research.ResearchError, "researcher sessions"):
            research.record(self.path, mission_id, {"claim": "x", "url": "https://x.org", "snippet": "y" * 30})
        research._job(self.path, mission_id)
        with self.assertRaisesRegex(research.ResearchError, "one format, the review"):
            research.make_format(self.path, mission_id, "quiz")
        with self.assertRaisesRegex(research.ResearchError, "Learn & understand"):
            research.followup(self.path, mission_id, {"questions": ["Why?"]})
        with self.assertRaisesRegex(research.ResearchError, "Only a Learn"):
            research.rewrite(self.path, mission_id, {})


class FunnelTest(unittest.TestCase):
    def test_the_funnel_always_adds_up(self) -> None:
        verdicts = [("include", None), ("unsure", None), ("exclude", "Humans"), ("exclude", None), ("found", None), ("unscreened", None)]
        for size in range(5):
            for rows in itertools.product(verdicts, repeat=size):
                for beyond in (0, 3):
                    funnel = research.funnel_counts(len(rows) + beyond, 2, list(rows))
                    self.assertEqual(funnel["found"], funnel["screened"] + funnel["unscreened"])
                    self.assertEqual(funnel["screened"], funnel["included"] + sum(funnel["excluded"].values()))
                    self.assertLessEqual(funnel["unsure"], funnel["included"])
        funnel = research.funnel_counts(4, 1, [("exclude", "Humans"), ("exclude", "Humans"), ("exclude", ""), ("include", None)])
        self.assertEqual(funnel["excluded"], {"Humans": 2, "Off topic": 1})


class QuoteCheckTest(unittest.TestCase):
    def extract(self, quote: str, value: str = "It fell.", field: str = "finding"):
        blank = {"value": "", "quote": ""}
        answer = {"question": blank, "design": blank, "sample": blank, "findings": [], "limitations": []}
        if field == "finding":
            answer["findings"] = [{"value": value, "quote": quote}]
        else:
            answer[field] = {"value": value, "quote": quote}
        research.ctx = SimpleNamespace(llm=SimpleNamespace(complete_structured=lambda **_: SimpleNamespace(parsed=answer)))
        self.addCleanup(setattr, research, "ctx", None)
        row = {"title": "T", "year": 2020, "venue": "V", "preprint": 0}
        text = "Accuracy on the n-back task fell by 12% after sleep deprivation. It was a randomised controlled trial."
        return research.extract({"goal": "Q"}, row, "abstract", text)

    def test_a_field_is_kept_only_with_a_quote_the_text_holds(self) -> None:
        self.assertEqual(self.extract("accuracy on the N-BACK task   fell by 12%"), ([("finding", "It fell.", "accuracy on the N-BACK task   fell by 12%")], 0))
        self.assertEqual(self.extract("Accuracy on the n-back task … after sleep deprivation."), ([("finding", "It fell.", "Accuracy on the n-back task … after sleep deprivation.")], 0))
        self.assertEqual(self.extract("Accuracy on the n-back task rose by 12%"), ([], 1))
        self.assertEqual(self.extract("Accuracy on the n-back task … rose sharply"), ([], 1))
        # Too short to find a passage by, or longer than a short quote: dropped either way.
        self.assertEqual(self.extract("fell by 12%"), ([], 1))
        self.assertEqual(self.extract("Accuracy " * 80), ([], 1))
        # A value with nothing said is not a field, so nothing is dropped for it.
        self.assertEqual(self.extract("", value=""), ([], 0))
        # A design the review has no word for is dropped, even with a real quote.
        self.assertEqual(self.extract("a randomised controlled trial", "experiment", "design"), ([], 1))
        self.assertEqual(self.extract("a randomised controlled trial", "trial", "design"), ([("design", "trial", "a randomised controlled trial")], 0))


class LiteratureRouteTest(unittest.TestCase):
    """A review's reading as the routes start it: on the plugin's own thread, with no run posted."""

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
        research.ctx = SimpleNamespace(llm=FakeLlm())
        self.addCleanup(setattr, research, "adapter", None)
        self.addCleanup(setattr, research, "ctx", None)
        self.posts: list = []

        async def post(_adapter, _profile, url, body, authorization=None):
            self.posts.append((url, body))
            return {"run_id": "run_1"}

        for target, name, value in (
            (research.push, "notify", mock.MagicMock()),
            (plugin.outbox, "post", post),
            (research, "spawn", mock.MagicMock()),
        ):
            patch = mock.patch.object(target, name, value)
            setattr(self, name, patch.start())
            self.addCleanup(patch.stop)

    def ask(self, action: str, body: Optional[dict] = None):
        request = FakeWeb.Request()
        request.headers = {}
        request.match_info = {"mission_id": self.mission_id}

        async def read():
            return body or {}

        request.json = read
        return asyncio.run(route(self.app, f"{plugin.PREFIX}/research/{{mission_id}}/{action}")(request))

    def test_info_advertises_the_type(self) -> None:
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(route(self.app, plugin.PREFIX + "/info")(request))
        self.assertIn("research_literature", answer.payload["features"])

    def test_start_and_try_again_post_no_run_and_the_watcher_leaves_the_mission_alone(self) -> None:
        self.mission_id = research.create(self.path, None, "sleep and working memory", "literature")["id"]
        research._job(self.path, self.mission_id)
        self.assertEqual(self.ask("brief", {"goal": "Q?", "criteria": ["Humans"]}).status, 200)
        answer = self.ask("start", {"queries": ["sleep working memory"], "cap": 10, "preprints": True})
        self.assertEqual((answer.status, answer.payload["mission"]["stage"]), (200, "reading"))
        self.assertEqual(self.posts, [])
        self.assertEqual(self.spawn.call_args.args[:2], (self.path, self.mission_id))
        # Nothing watches a run that doesn't exist, so the mission is never failed for one.
        self.assertEqual(research._check_watched(), [])
        self.assertIsNone(research.mission(self.path, self.mission_id)["error"])

        research._update(self.path, self.mission_id, error="OpenAlex couldn't be reached.")
        spawned = self.spawn.call_count
        self.assertEqual(self.ask("retry").status, 200)
        self.assertEqual((self.posts, self.spawn.call_count), ([], spawned + 1))
        self.assertIsNone(research.mission(self.path, self.mission_id)["error"])

    def test_a_restart_picks_a_reading_review_up_on_its_own_thread(self) -> None:
        self.mission_id = research.create(self.path, None, "sleep and working memory", "literature")["id"]
        research._update(self.path, self.mission_id, stage="reading", busy=None)
        research._resumed.discard(str(self.path))
        research.resume(self.path)
        self.assertEqual(self.spawn.call_args.args[:2], (self.path, self.mission_id))
        self.assertEqual(research._check_watched(), [])


if __name__ == "__main__":
    unittest.main()
