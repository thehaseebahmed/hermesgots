"""A bot's dictation log: the durable copy of the words a take landed, and its totals.

Run: python3 -m unittest plugin.tests.test_dictations -v
"""

from __future__ import annotations

import sqlite3
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
            {key: found[key] for key in ("id", "text", "words", "ms", "at")},
            {"id": "d1", "text": "two words", "words": 2, "ms": 1500, "at": 1},
        )
        self.assertGreater(found["seenAt"], 0, "the host stamps when it heard the take")
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

    def test_a_take_that_lands_after_a_clear_is_kept_and_heard_after_it(self) -> None:
        stamped = dictations.clear(self.path, "bot-a")["clearedAt"]
        found = dictations.record(self.path, "bot-a", {"id": "late", "text": "after", "at": 5})
        # Its words keep the time they were said; the log orders it by when the host heard it, which
        # is after the clear, so nothing has to be stamped over the device's own clock for the order
        # to be right.
        self.assertEqual(found["at"], 5)
        self.assertGreater(found["seenAt"], stamped)
        self.assertEqual([row["id"] for row in dictations.rows(self.path, "bot-a")], ["late"])

    def test_one_id_belongs_to_each_profile_on_its_own(self) -> None:
        self.add(profile="bot-a", text="mine")
        self.add(profile="bot-b", text="yours")
        self.assertEqual([row["text"] for row in dictations.rows(self.path, "bot-a")], ["mine"])
        self.assertEqual([row["text"] for row in dictations.rows(self.path, "bot-b")], ["yours"])

    def test_a_page_is_newest_first_by_arrival(self) -> None:
        for at in (10, 30, 20):
            self.add(at=at)
        # Newest is the last one the host heard, not the latest time a device claimed for one: those
        # stamps come from clocks this machine cannot check.
        self.assertEqual([row["at"] for row in dictations.rows(self.path, "bot-a")], [20, 30, 10])

    def test_a_page_is_bounded_and_the_cursor_walks_back(self) -> None:
        for at in range(1, 8):
            self.add(at=at)
        first = dictations.rows(self.path, "bot-a", limit=3)
        self.assertEqual([row["at"] for row in first], [7, 6, 5])
        older = dictations.rows(
            self.path,
            "bot-a",
            before=first[-1]["seenAt"],
            before_id=first[-1]["id"],
            limit=3,
        )
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
        first = self.add(profile="bot-a", text="one two", words=2, ms=1000, at=10)
        second = self.add(profile="bot-a", text="three", words=1, ms=500, at=40)
        self.add(profile="bot-b", text="four", words=1, ms=9000, at=20)
        found = dictations.stats(self.path, "bot-a")
        self.assertEqual(
            found,
            {
                "words": 3,
                "ms": 1500,
                "count": 2,
                "newest": second["seenAt"],
                "oldest": first["seenAt"],
                "clearedAt": 0,
            },
        )

    def test_a_clock_in_the_future_is_clamped_to_when_the_take_arrived(self) -> None:
        found = self.add(at=dictations._now() + 86_400_000)
        self.assertLessEqual(found["at"], found["seenAt"], "nothing claims a time ahead of this host")

    def test_takes_that_share_a_millisecond_are_all_reachable(self) -> None:
        # What an unset clock writes, or a backfilled store: sixty takes at one instant. The cursor's
        # id half is what keeps the page from skipping the rest of them, which a bound on the time
        # alone did.
        conn = connect(self.path)
        for n in range(60):
            conn.execute(
                "INSERT INTO dictations (id, profile, text, words, ms, at, seen_at) "
                "VALUES (?, 'bot-a', 'a take', 1, 0, 1000, 5000)",
                (f"t{n:02d}",),
            )
        conn.commit()
        conn.close()

        seen, cursor = [], None
        for _ in range(5):
            page = dictations.rows(
                self.path,
                "bot-a",
                before=cursor[0] if cursor else None,
                before_id=cursor[1] if cursor else None,
                limit=50,
            )
            seen.extend(page)
            if len(page) < 50:
                break
            cursor = (page[-1]["seenAt"], page[-1]["id"])

        self.assertEqual(len(seen), 60)
        self.assertEqual(len({row["id"] for row in seen}), 60)

    def test_a_store_without_the_hosts_clock_backfills_it_from_the_device_time(self) -> None:
        conn = connect(self.path)
        conn.execute("DROP INDEX dictation_order")
        conn.execute("ALTER TABLE dictations DROP COLUMN seen_at")
        conn.execute("PRAGMA user_version = 45")
        conn.execute(
            "INSERT INTO dictations (id, profile, text, words, ms, at) "
            "VALUES ('old', 'bot-a', 'kept', 1, 10, 7)"
        )
        conn.commit()
        conn.close()

        rows = dictations.rows(self.path, "bot-a")
        self.assertEqual([(row["id"], row["seenAt"]) for row in rows], [("old", 7)])

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


class OldShapeStoreTest(unittest.TestCase):
    """A store that ran the build before the key was per profile keeps its rows and gains the key."""

    OLD = """
        CREATE TABLE dictations (
            id TEXT PRIMARY KEY,
            profile TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            words INTEGER NOT NULL DEFAULT 0,
            ms INTEGER NOT NULL DEFAULT 0,
            at INTEGER NOT NULL,
            device TEXT
        );
        CREATE INDEX dictation_time ON dictations (profile, at);
        INSERT INTO dictations (id, profile, text, words, ms, at, device)
            VALUES ('d1', 'bot-a', 'kept through the rebuild', 4, 900, 5, 'phone');
        PRAGMA user_version = 44;
    """

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path)
        conn.executescript(self.OLD)
        conn.commit()
        conn.close()

    def shape(self) -> str:
        conn = sqlite3.connect(self.path)
        try:
            return conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dictations'"
            ).fetchone()[0]
        finally:
            conn.close()

    def test_the_migration_rekeys_the_table_and_keeps_its_rows(self) -> None:
        connect(self.path).close()
        shape = self.shape()
        self.assertIn("PRIMARY KEY (profile, id)", shape)
        self.assertNotIn("device", shape)
        self.assertEqual(
            [row["text"] for row in dictations.rows(self.path, "bot-a")],
            ["kept through the rebuild"],
        )

    def test_an_id_two_profiles_share_is_stored_for_both_after_the_rebuild(self) -> None:
        connect(self.path).close()
        other = dictations.record(self.path, "bot-b", {"id": "d1", "text": "the other bot", "at": 6})
        self.assertEqual(other["text"], "the other bot")
        self.assertEqual(
            [row["text"] for row in dictations.rows(self.path, "bot-a")],
            ["kept through the rebuild"],
        )

    def test_a_migrated_store_keeps_its_index_and_its_version(self) -> None:
        connect(self.path).close()
        conn = sqlite3.connect(self.path)
        try:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master")}
            version = conn.execute("PRAGMA user_version").fetchone()[0]
        finally:
            conn.close()
        self.assertIn("dictation_order", tables)
        self.assertNotIn("dictations_v44", tables)
        self.assertEqual(version, 46)


if __name__ == "__main__":
    unittest.main()
