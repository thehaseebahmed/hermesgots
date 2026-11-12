"""A verification's verdict, by code: a part's stance, the claim's label and the sources behind them.

Run: python3 -m unittest plugin.tests.test_verdict -v
"""

from __future__ import annotations

import itertools
import unittest
from typing import Any, Dict, List

from plugin import research

PART_STANCES = ("supported", "refuted", "disputed", "thin", "cant_tell", "not_supported")
LABELS = ("supported", "partly_supported", "disputed", "not_supported", "refuted", "cant_tell", "thin")


class Ledger:
    """A fabricated ledger, built a claim at a time, each claim on its own source unless told."""

    def __init__(self) -> None:
        self.sources: List[Dict[str, Any]] = []
        self.claims: List[Dict[str, Any]] = []
        self.tags: List[Dict[str, Any]] = []

    def claim(self, part: str, stance: str, url: str = "", confidence: str = "supported", tag: Any = "same") -> str:
        number = len(self.claims) + 1
        source = f"s{number}"
        self.sources.append({"id": source, "url": url or f"https://site{number}.example{number}.org/page", "title": "T"})
        claim_id = f"c{number}"
        self.claims.append(
            {"id": claim_id, "text": "x", "source": source, "snippet": "y", "confidence": confidence, "stance": stance, "part": part, "lane": "for"}
        )
        if tag:
            self.tags.append({"claim": claim_id, "part": part, "stance": stance if tag == "same" else tag})
        return claim_id

    def side(self, part: str, stance: str, count: int) -> None:
        for _ in range(count):
            self.claim(part, stance)

    def verdict(self, parts: List[str]) -> Dict[str, Any]:
        return research.verdict(
            [{"id": part, "text": f"Part {part}"} for part in parts],
            {"sources": self.sources, "claims": self.claims},
            self.tags,
        )


def expected_stance(s: int, r: int, other: bool) -> tuple:
    """The part's stance as the plan states it, cell by cell."""
    if s >= 1 and r >= 1:
        return ("disputed", None)
    if s >= 2:
        return ("supported", None)
    if r >= 2:
        return ("refuted", None)
    if s == 1:
        return ("thin", "supports")
    if r == 1:
        return ("thin", "refutes")
    return ("cant_tell", None) if other else ("not_supported", None)


def make_part(ledger: Ledger, part: str, stance: str) -> None:
    """Evidence that gives one part the stance named (``thin+``/``thin-`` for the two directions)."""
    if stance == "supported":
        ledger.side(part, "supports", 2)
    elif stance == "refuted":
        ledger.side(part, "refutes", 2)
    elif stance == "disputed":
        ledger.side(part, "supports", 1)
        ledger.side(part, "refutes", 1)
    elif stance == "thin+":
        ledger.side(part, "supports", 1)
    elif stance == "thin-":
        ledger.side(part, "refutes", 1)
    elif stance == "cant_tell":
        ledger.claim(part, "supports", confidence="uncertain")


def expected_label(stances: tuple) -> str:
    """The claim's label by the plan's precedence."""
    plain = ["thin" if stance.startswith("thin") else stance for stance in stances]
    if "refuted" in plain:
        return "refuted"
    if "disputed" in plain:
        return "disputed"
    if all(stance == "supported" for stance in plain):
        return "supported"
    if "supported" in plain:
        return "partly_supported"
    if "thin" in plain:
        return "thin"
    if all(stance == "not_supported" for stance in plain):
        return "not_supported"
    return "cant_tell"


class VerdictTests(unittest.TestCase):
    def test_every_pair_of_source_counts_gives_a_part_exactly_one_stance(self) -> None:
        for s, r, other in itertools.product(range(4), range(4), (False, True)):
            with self.subTest(s=s, r=r, other=other):
                ledger = Ledger()
                ledger.side("p1", "supports", s)
                ledger.side("p1", "refutes", r)
                if other:
                    ledger.claim("p1", "context")
                part = ledger.verdict(["p1"])["parts"][0]
                self.assertIn(part["stance"], PART_STANCES)
                self.assertEqual((part["stance"], part["direction"]), expected_stance(s, r, other))
                self.assertEqual((part["supporting"], part["refuting"]), (s, r))
                self.assertEqual(len(part["for"]), s)
                self.assertEqual(len(part["against"]), r)

    def test_an_uncertain_or_disagreed_claim_is_evidence_that_takes_no_side(self) -> None:
        for kind in ("uncertain", "disagreed", "context"):
            with self.subTest(kind=kind):
                ledger = Ledger()
                if kind == "uncertain":
                    ledger.claim("p1", "supports", confidence="uncertain")
                elif kind == "disagreed":
                    ledger.claim("p1", "supports", tag="context")
                else:
                    ledger.claim("p1", "context")
                result = ledger.verdict(["p1"])
                self.assertEqual(result["parts"][0]["stance"], "cant_tell")
                self.assertEqual(result["leads"], 1 if kind == "uncertain" else 0)

    def test_every_combination_of_part_stances_gives_exactly_one_label(self) -> None:
        kinds = ("supported", "refuted", "disputed", "thin+", "thin-", "cant_tell", "not_supported")
        reached = set()
        for size in range(1, 5):
            for stances in itertools.combinations_with_replacement(kinds, size):
                with self.subTest(stances=stances):
                    ledger = Ledger()
                    parts = [f"p{index + 1}" for index in range(size)]
                    for part, stance in zip(parts, stances):
                        make_part(ledger, part, stance)
                    result = ledger.verdict(parts)
                    self.assertIn(result["label"], LABELS)
                    self.assertEqual(result["label"], expected_label(stances))
                    self.assertIsInstance(result["why"], str)
                    self.assertTrue(result["why"].strip())
                    self.assertEqual(result["why"].count("."), 1)
                    reached.add(result["label"])
        self.assertEqual(reached, set(LABELS))

    def test_a_thin_verdict_says_which_way_it_leans(self) -> None:
        leaning = Ledger()
        leaning.side("p1", "supports", 1)
        self.assertIn("support", leaning.verdict(["p1"])["why"])
        against = Ledger()
        against.side("p1", "refutes", 1)
        self.assertIn("against", against.verdict(["p1"])["why"])

    def test_evidence_that_could_not_be_checked_is_not_said_to_take_no_side(self) -> None:
        ledger = Ledger()
        ledger.claim("p1", "supports", confidence="uncertain")
        ledger.claim("p1", "supports", confidence="uncertain")
        result = ledger.verdict(["p1"])
        self.assertEqual(result["label"], "cant_tell")
        self.assertNotIn("takes a side", result["why"])
        self.assertIn("checked", result["why"])
        neutral = Ledger()
        neutral.claim("p1", "context")
        self.assertIn("takes a side", neutral.verdict(["p1"])["why"])

    def test_thin_evidence_from_several_sources_is_not_said_to_be_one_source(self) -> None:
        ledger = Ledger()
        ledger.claim("p1", "supports")
        ledger.claim("p2", "supports")
        result = ledger.verdict(["p1", "p2"])
        self.assertEqual((result["label"], result["sources"]), ("thin", 2))
        self.assertNotIn("Only one source bears on it", result["why"])
        self.assertIn("support", result["why"])
        self.assertEqual(result["why"].count("."), 1)

    def test_a_tag_the_researcher_did_not_record_does_not_count(self) -> None:
        ledger = Ledger()
        # The researcher recorded refutes; the judge tagged supports.
        ledger.claim("p1", "refutes", tag="supports")
        # Tagged on a part the researcher did not record it for.
        ledger.claim("p1", "supports", tag=None)
        ledger.tags.append({"claim": "c2", "part": "p2", "stance": "supports"})
        result = ledger.verdict(["p1", "p2"])
        first, second = result["parts"]
        self.assertEqual((first["stance"], first["supporting"], first["refuting"]), ("cant_tell", 0, 0))
        self.assertEqual((second["stance"], second["supporting"], second["refuting"]), ("cant_tell", 0, 0))
        self.assertEqual(result["sources"], 0)
        self.assertEqual(result["label"], "cant_tell")

    def test_two_pages_on_one_registrable_domain_are_one_source(self) -> None:
        same = [
            ("https://a.example.com/one", "https://b.example.com/two"),
            ("https://www.example.com/", "http://example.com:8080/x"),
            ("https://news.bbc.co.uk/a", "https://www.bbc.co.uk/b"),
            ("https://WWW.Example.COM/a", "https://example.com/b"),
            ("http://192.168.0.1/a", "http://192.168.0.1:8080/b"),
            ("https://a.example.co/x", "https://b.example.co/y"),
        ]
        apart = [
            ("https://bbc.co.uk/a", "https://www.gov.uk/b"),
            ("https://example.com/a", "https://example.org/b"),
            ("http://192.168.0.1/a", "http://192.168.0.2/a"),
            ("https://bbc.co.uk/a", "https://itv.co.uk/b"),
        ]
        for urls, independent in [(pair, 1) for pair in same] + [(pair, 2) for pair in apart]:
            with self.subTest(urls=urls):
                ledger = Ledger()
                for url in urls:
                    ledger.claim("p1", "supports", url=url)
                result = ledger.verdict(["p1"])
                self.assertEqual(result["parts"][0]["supporting"], independent)
                self.assertEqual(result["sources"], independent)
                self.assertEqual(len(result["parts"][0]["for"]), 2)
        # The two-letter-TLD rule keeps the subdomain only under a generic second level.
        self.assertEqual(research.registrable_domain("https://a.example.co/x"), "example.co")
        self.assertEqual(research.registrable_domain("https://news.bbc.co.uk/"), "bbc.co.uk")
        self.assertEqual(research.registrable_domain("http://[::1]:9000/"), "::1")


if __name__ == "__main__":
    unittest.main()
