"""The scholarly index client: what a work is read as, how queries' papers fold, and what the
index's refusals say.

The fixture holds two works as the live API answered them on 2026-11-12 (``GET /works/<id>``, with
each authorship cut to the author's name); the ``results`` list around them is this fixture's own.

Run: python3 -m unittest plugin.tests.test_scholar -v
"""

from __future__ import annotations

import io
import json
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest import mock

from plugin import scholar

WORKS = json.loads((Path(__file__).parent / "fixtures" / "openalex_works.json").read_text())["results"]


def item(title: str, doi: str = "", **fields):
    return {
        "title": title, "authors": [], "more_authors": 0, "year": None, "venue": "", "doi": doi,
        "url": f"https://example.org/{title}", "preprint": False, "abstract": "", "text_urls": [], **fields,
    }


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class PaperTest(unittest.TestCase):
    def test_a_real_work_is_read_as_its_metadata_abstract_and_open_copy(self) -> None:
        found = scholar.paper(WORKS[0])
        self.assertEqual(found["title"], "The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles")
        self.assertEqual((found["year"], found["venue"], found["preprint"]), (2018, "PeerJ", False))
        self.assertEqual(found["doi"], "10.7717/peerj.4375")
        self.assertEqual(found["url"], "https://doi.org/10.7717/peerj.4375")
        self.assertEqual(found["authors"][:2], ["Heather Piwowar", "Jason R Priem"])
        # The abstract comes back as a map of words to positions and is rebuilt in order.
        self.assertTrue(found["abstract"].startswith("Despite growing interest in Open Access (OA) to"))
        self.assertEqual(found["text_urls"], ["https://doi.org/10.7717/peerj.4375"])

    def test_a_preprints_open_copy_is_its_page_then_its_pdf(self) -> None:
        found = scholar.paper(WORKS[1])
        self.assertTrue(found["preprint"])
        self.assertEqual(found["text_urls"], ["http://arxiv.org/abs/1706.03762", "https://arxiv.org/pdf/1706.03762"])

    def test_a_copy_the_index_does_not_call_open_is_never_fetched(self) -> None:
        work = json.loads(json.dumps(WORKS[0]))
        work["best_oa_location"]["is_oa"] = False
        self.assertEqual(scholar.paper(work)["text_urls"], [])
        work["best_oa_location"] = None
        work["abstract_inverted_index"] = None
        found = scholar.paper(work)
        self.assertEqual((found["text_urls"], found["abstract"]), ([], ""))

    def test_a_work_with_no_title_is_no_paper(self) -> None:
        self.assertIsNone(scholar.paper({**WORKS[0], "display_name": " "}))
        self.assertIsNone(scholar.paper("nope"))

    def test_an_abstract_index_that_is_not_one_is_empty(self) -> None:
        self.assertEqual(scholar.abstract_text({"b": [1], "a": [0, 2], "x": "no", 3: [9]}), "a b a")
        self.assertEqual(scholar.abstract_text(None), "")


class MergeTest(unittest.TestCase):
    def test_a_repeat_by_doi_or_by_title_is_one_paper(self) -> None:
        first = [item("Sleep and memory", "10.1/a"), item("Naps: a trial")]
        second = [
            item("Sleep & Memory!", "10.1/a", abstract="Kept."),  # the same DOI
            item("NAPS - a trial", "10.1/b", venue="Sleep"),  # the same title's words
            item("Something else", "10.1/c"),
        ]
        merged, duplicates = scholar.merge([first, second])
        self.assertEqual([paper["title"] for paper in merged], ["Sleep and memory", "Naps: a trial", "Something else"])
        self.assertEqual(duplicates, 2)
        # A repeat fills in what the kept row lacked.
        self.assertEqual(merged[0]["abstract"], "Kept.")
        self.assertEqual((merged[1]["doi"], merged[1]["venue"]), ("10.1/b", "Sleep"))

    def test_each_querys_best_come_first(self) -> None:
        merged, duplicates = scholar.merge([[item("a1"), item("a2")], [item("b1"), item("b2"), item("b3")]])
        self.assertEqual([paper["title"] for paper in merged], ["a1", "b1", "a2", "b2", "b3"])
        self.assertEqual(duplicates, 0)

    def test_nothing_found_merges_to_nothing(self) -> None:
        self.assertEqual(scholar.merge([]), ([], 0))
        self.assertEqual(scholar.merge([[], []]), ([], 0))


class SearchTest(unittest.TestCase):
    def test_a_search_asks_for_the_years_and_types_and_sends_the_key_as_a_header(self) -> None:
        seen = {}

        def urlopen(request, timeout=None):
            seen["url"], seen["headers"] = request.full_url, dict(request.header_items())
            return Answer(json.dumps({"results": [WORKS[0], {"display_name": ""}]}).encode())

        with mock.patch.object(scholar.urllib.request, "urlopen", urlopen):
            found = scholar.search("sleep memory", 2018, 2024, preprints=False, key="k-1")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(seen["url"]).query)
        self.assertEqual(query["search"], ["sleep memory"])
        self.assertEqual(
            query["filter"],
            ["type:article|review,is_retracted:false,from_publication_date:2018-01-01,to_publication_date:2024-12-31"],
        )
        self.assertEqual(seen["headers"]["Authorization"], "Bearer k-1")
        self.assertNotIn("k-1", seen["url"])
        self.assertEqual([paper["doi"] for paper in found], ["10.7717/peerj.4375"])

        with mock.patch.object(scholar.urllib.request, "urlopen", urlopen):
            scholar.search("sleep", preprints=True)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(seen["url"]).query)
        self.assertEqual(query["filter"], ["type:article|review|preprint,is_retracted:false"])
        self.assertNotIn("Authorization", seen["headers"])

    def refused(self, code: int, key=None) -> str:
        def urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, code, "no", {}, io.BytesIO(b"{}"))

        with mock.patch.object(scholar.urllib.request, "urlopen", urlopen):
            with self.assertRaises(scholar.IndexError_) as failed:
                scholar.search("sleep", key=key)
        return str(failed.exception)

    def test_a_spent_budget_names_the_key_that_would_lift_it(self) -> None:
        self.assertIn("OPENALEX_API_KEY", self.refused(429))
        self.assertIn("this key's daily budget", self.refused(429, key="k-1"))
        self.assertIn("refused the key", self.refused(401, key="k-1"))
        self.assertIn("answered 500", self.refused(500))

    def test_an_answer_that_is_not_a_result_list_is_an_error(self) -> None:
        with mock.patch.object(scholar.urllib.request, "urlopen", lambda *_a, **_k: Answer(b"<html>")):
            with self.assertRaisesRegex(scholar.IndexError_, "isn't JSON"):
                scholar.search("sleep")
        with mock.patch.object(scholar.urllib.request, "urlopen", lambda *_a, **_k: Answer(b'{"error": "x"}')):
            with self.assertRaisesRegex(scholar.IndexError_, "without a list"):
                scholar.search("sleep")


class ReferenceTest(unittest.TestCase):
    def test_a_reference_is_the_metadata_in_one_line(self) -> None:
        source = {**scholar.paper(WORKS[1])}
        line = scholar.reference(source)
        self.assertTrue(line.startswith("Ashish Vaswani, Noam Shazeer, "))
        self.assertIn(", et al. (2017). Attention Is All You Need. arXiv (Cornell University). Preprint. ", line)
        self.assertTrue(line.endswith("https://doi.org/10.48550/arxiv.1706.03762"))
        self.assertEqual(
            scholar.reference({"title": "A title.", "authors": [], "year": None, "venue": "", "url": "https://x.org/1"}),
            "A title. https://x.org/1",
        )


if __name__ == "__main__":
    unittest.main()
