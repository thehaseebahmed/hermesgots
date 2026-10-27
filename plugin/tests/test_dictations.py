"""A bot's dictation log: the durable copy of the words a take landed, and its totals.

Run: python3 -m unittest plugin.tests.test_dictations -v
"""

from __future__ import annotations

import unittest

from plugin import dictations
from plugin.store import connect, db_path
from plugin.tests._helpers import temp_hermes_home


class DictationsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.n = 0

    def add(self, profile="bot-a", text="a spoken line", at=None, **kw):
        self.n += 1
        return dictations.record(
            self.path,
            profile,
            {"id": f"d{self.n}", "text": text, "at": at if at is not None else self.n, **kw},
        )

    def test_a_write_is_the_row_that_is_read_back(self) -> None:
        found = self.add(text="two words", words=2, ms=1500)
        self.assertEqual(
            found, {"id": "d1", "text": "two words", "words": 2, "ms": 1500, "at": 1}
        )
        self.assertEqual(dictations.rows(self.path, "bot-a"), [found])

    def test_the_words_are_counted_when_the_body_names_none(self) -> None:
        self.assertEqual(self.add(text="one two  three\nfour")["words"], 4)

    def test_a_rewritten_entry_leaves_the_first_in_place(self) -> None:
        self.add(text="as heard")
        again = dictations.record(self.path, "bot-a", {"id": "d1", "text": "as heard again"})
        self.assertEqual(again["text"], "as heard")
        self.assertEqual(len(dictations.rows(self.path, "bot-a")), 1)

    def test_a_body_without_words_is_refused(self) -> None:
        for body in ({}, {"id": "d1"}, {"id": "d1", "text": "   "}, {"text": "words"}):
            with self.assertRaises(dictations.DictationLogError):
                dictations.record(self.path, "bot-a", body)

    def test_a_negative_span_is_refused(self) -> None:
        with self.assertRaises(dictations.DictationLogError):
            dictations.record(self.path, "bot-a", {"id": "d1", "text": "w", "ms": -1})

    def test_a_take_that_lands_after_a_clear_is_stored_above_its_stamp(self) -> None:
        stamped = dictations.clear(self.path, "bot-a")["clearedAt"]
        found = dictations.record(self.path, "bot-a", {"id": "late", "text": "after", "at": 5})
        self.assertGreater(found["at"], stamped)
        self.assertEqual([row["id"] for row in dictations.rows(self.path, "bot-a")], ["late"])

    def test_one_id_belongs_to_each_profile_on_its_own(self) -> None:
        self.add(profile="bot-a", text="mine")
        self.add(profile="bot-b", text="yours")
        self.assertEqual([row["text"] for row in dictations.rows(self.path, "bot-a")], ["mine"])
        self.assertEqual([row["text"] for row in dictations.rows(self.path, "bot-b")], ["yours"])

    def test_a_page_is_newest_first(self) -> None:
        for at in (10, 30, 20):
            self.add(at=at)
        self.assertEqual([row["at"] for row in dictations.rows(self.path, "bot-a")], [30, 20, 10])

    def test_a_page_is_bounded_and_before_walks_back(self) -> None:
        for at in range(1, 8):
            self.add(at=at)
        first = dictations.rows(self.path, "bot-a", limit=3)
        self.assertEqual([row["at"] for row in first], [7, 6, 5])
        older = dictations.rows(self.path, "bot-a", before=first[-1]["at"], limit=3)
        self.assertEqual([row["at"] for row in older], [4, 3, 2])

    def test_one_profile_never_reads_another(self) -> None:
        self.add(profile="bot-a", at=1)
        self.add(profile="bot-b", at=2)
        self.assertEqual([row["at"] for row in dictations.rows(self.path, "bot-a")], [1])
        self.assertEqual([row["at"] for row in dictations.rows(self.path, "bot-b")], [2])

    def test_a_removal_takes_only_its_own_profiles_row(self) -> None:
        self.add(profile="bot-a", at=1)
        self.add(profile="bot-b", at=2)
        self.assertTrue(dictations.remove(self.path, "bot-a", "d1"))
        self.assertFalse(dictations.remove(self.path, "bot-a", "d1"))
        self.assertFalse(dictations.remove(self.path, "bot-a", "d2"))
        self.assertEqual([row["id"] for row in dictations.rows(self.path, "bot-b")], ["d2"])

    def test_a_clear_empties_one_profile_and_stamps_the_clock(self) -> None:
        self.add(profile="bot-a", at=1)
        self.add(profile="bot-b", at=2)
        found = dictations.clear(self.path, "bot-a")
        self.assertEqual(found["count"], 0)
        self.assertGreater(found["clearedAt"], 0)
        self.assertEqual(dictations.rows(self.path, "bot-a"), [])
        self.assertEqual(len(dictations.rows(self.path, "bot-b")), 1)
        self.assertGreater(dictations.stats(self.path, "bot-a")["clearedAt"], 0)
        self.assertEqual(dictations.stats(self.path, "bot-b")["clearedAt"], 0)

    def test_stats_are_the_profiles_totals_and_its_fingerprint(self) -> None:
        self.add(profile="bot-a", text="one two", words=2, ms=1000, at=10)
        self.add(profile="bot-a", text="three", words=1, ms=500, at=40)
        self.add(profile="bot-b", text="four", words=1, ms=9000, at=20)
        found = dictations.stats(self.path, "bot-a")
        self.assertEqual(
            found,
            {"words": 3, "ms": 1500, "count": 2, "newest": 40, "oldest": 10, "clearedAt": 0},
        )

    def test_an_absent_store_reads_empty_rather_than_writing_one(self) -> None:
        absent = self.home / "nothing.db"
        self.assertEqual(dictations.rows(absent, "bot-a"), [])
        self.assertEqual(dictations.stats(absent, "bot-a")["count"], 0)
        self.assertFalse(dictations.remove(absent, "bot-a", "d1"))
        self.assertFalse(absent.exists())

    def test_a_store_at_the_last_version_gains_the_tables(self) -> None:
        # A store written before this feature: connecting it again runs the migration, and the
        # tables it adds are what the routes write into.
        conn = connect(self.path)
        conn.execute("DROP TABLE dictations")
        conn.execute("DROP TABLE dictation_state")
        conn.execute("PRAGMA user_version = 43")
        conn.close()
        self.add(at=5)
        self.assertEqual(dictations.stats(self.path, "bot-a")["count"], 1)


if __name__ == "__main__":
    unittest.main()
