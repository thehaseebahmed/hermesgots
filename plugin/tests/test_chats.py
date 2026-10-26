"""The chat list's draft text and picked mode, and the size cap they fit under.

Run: python3 -m unittest plugin.tests.test_chats -v
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import chats
from plugin.store import SCHEMA_VERSION, db_path


class DraftsAndModes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))

    def test_a_newer_record_carries_its_draft_and_mode(self):
        chats.merge(self.path, {"a": {"at": 1, "value": {"draftText": "old", "mode": "accept_edits"}}})
        merged = chats.merge(self.path, {"a": {"at": 2, "value": {"draftText": "new", "mode": "plan"}}})
        self.assertEqual(merged["a"]["value"], {"draftText": "new", "mode": "plan"})

    def test_an_older_record_does_not_overwrite_the_draft(self):
        chats.merge(self.path, {"a": {"at": 5, "value": {"draftText": "kept"}}})
        merged = chats.merge(self.path, {"a": {"at": 2, "value": {"draftText": "stale"}}})
        self.assertEqual(merged["a"]["value"]["draftText"], "kept")

    def test_a_twenty_kb_draft_is_accepted(self):
        merged = chats.merge(self.path, {"a": {"at": 1, "value": {"draftText": "x" * (20 * 1024)}}})
        self.assertEqual(len(merged["a"]["value"]["draftText"]), 20 * 1024)

    def test_a_record_over_64_kb_is_rejected_whole(self):
        with self.assertRaises(chats.InvalidChats):
            chats.merge(
                self.path,
                {"a": {"at": 1, "value": {"draftText": "x" * (64 * 1024)}}, "b": {"at": 1, "value": {}}},
            )
        self.assertEqual(chats.read(self.path), {})


class SessionPins(unittest.TestCase):
    """A chat found by the session a run is posted on, and the model its record pins it to.

    Two keys exist: AFK's record is keyed by the session id, one the app made is keyed by the chat
    id with the session in its value. A run knows only the session id, so the lookup has to find
    either, and a closed record is no session at all.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))

    def merge(self, chat_id, value, at=1):
        return chats.merge(self.path, {chat_id: {"at": at, "value": value}})

    def test_a_session_keyed_record_is_found_by_its_own_id(self):
        # AFK's record: the id it is keyed by is the session the run goes to.
        self.merge(
            "memento-afk-1",
            {
                "hermesSessionId": "memento-afk-1",
                "modelChoice": {"provider": "deepseek", "model": "deepseek-v4-pro"},
            },
        )
        found = chats.by_session(self.path, "memento-afk-1")
        self.assertEqual(chats.choice(found), {"provider": "deepseek", "model": "deepseek-v4-pro"})

    def test_a_chat_keyed_record_is_found_by_the_session_its_value_names(self):
        # The app's own record: a chat id for a key, the Hermes session inside the value.
        self.merge(
            "chat-1",
            {
                "hermesSessionId": "memento-chat-1",
                "modelChoice": {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
            },
        )
        found = chats.by_session(self.path, "memento-chat-1")
        self.assertEqual(
            chats.choice(found), {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"}
        )

    def test_a_session_with_no_record_or_no_pick_pins_nothing(self):
        self.assertEqual(chats.by_session(self.path, "memento-nothing"), None)
        self.merge("chat-1", {"hermesSessionId": "memento-chat-1"})
        self.assertIsNone(chats.choice(chats.by_session(self.path, "memento-chat-1")))
        self.assertIsNone(chats.by_session(self.path, ""))

    def test_a_closed_record_is_no_session(self):
        # A resolve or a discard in the app, and a deletion outright: the session is over, and
        # nothing posts a run of one.
        self.merge("chat-1", {"hermesSessionId": "s", "discardedAt": 2}, at=5)
        self.merge("chat-2", {"hermesSessionId": "t", "resolvedAt": 2}, at=5)
        chats.merge(self.path, {"memento-afk-1": {"at": 6, "deleted": True}})
        for session_id in ("s", "t", "memento-afk-1"):
            self.assertIsNone(chats.by_session(self.path, session_id), session_id)

    def test_a_half_written_pick_pins_nothing(self):
        for number, held in enumerate(
            (
                {"provider": "openrouter"},
                {"model": "a/b"},
                {"provider": "", "model": "a/b"},
                {"provider": "openrouter", "model": ""},
                {"provider": 1, "model": "a/b"},
                {},
                "openrouter/a/b",
            ),
            start=1,
        ):
            self.merge("chat-1", {"hermesSessionId": "s", "modelChoice": held}, at=number)
            self.assertIsNone(
                chats.choice(chats.by_session(self.path, "s")),
                f"{held}: a run told one name and not the other is refused, not guessed at",
            )

    def test_a_record_that_is_not_a_chat_pins_nothing(self):
        self.assertIsNone(chats.choice(None))
        self.assertIsNone(chats.choice({"at": 1, "deleted": True}))
        self.assertIsNone(chats.choice({"at": 1, "value": {"modelChoice": {}}}))

    def test_a_store_already_at_v42_gains_the_session_index(self):
        # v42 shipped on this branch before the expression index joined the block, so a store that
        # took it never ran the block again and never built the index: the bump to 43 is that block
        # reached once more. The query answers either way — this is the scan it was there to save.
        self.merge("chat-1", {"hermesSessionId": "s"})
        conn = sqlite3.connect(self.path)
        conn.execute("DROP INDEX chat_session")
        conn.execute("PRAGMA user_version = 42")
        conn.commit()
        conn.close()
        chats.by_session(self.path, "s")
        conn = sqlite3.connect(self.path)
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(chats)")}
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        conn.close()
        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIn("chat_session", indexes)


class ThePinRule(unittest.TestCase):
    """A pick is both halves or nothing, written one way and read one way.

    AFK's stages, a wake and a triaged thread all ask this module what model a session keeps, and
    all of them name it on the run the same way: one reading and one spelling, in the one place
    that owns the rule, so no seam can drift from another and send a run somewhere the record
    never named.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))

    def merge(self, chat_id, value, at=1):
        return chats.merge(self.path, {chat_id: {"at": at, "value": value}})

    def test_a_pick_names_both_halves_or_nothing(self):
        self.assertEqual(
            chats.pick("openrouter", "anthropic/claude-sonnet-4.5"),
            {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
        )
        for provider, model in (
            ("", "a/b"),
            ("openrouter", ""),
            (None, "a/b"),
            ("openrouter", None),
            (1, "a/b"),
            ("openrouter", 2),
            (None, None),
        ):
            self.assertIsNone(chats.pick(provider, model), f"half a pick: {provider!r}/{model!r}")

    def test_pin_is_the_sessions_pick_or_nothing(self):
        self.merge(
            "chat-1",
            {
                "hermesSessionId": "s",
                "modelChoice": {"provider": "deepseek", "model": "deepseek-v4-pro"},
            },
        )
        self.assertEqual(
            chats.pin(self.path, "s"), {"provider": "deepseek", "model": "deepseek-v4-pro"}
        )
        self.assertIsNone(chats.pin(self.path, "memento-nothing"))
        self.assertIsNone(chats.pin(self.path, ""))

    def test_a_store_it_cannot_read_is_no_pin(self):
        """A pick is never worth losing a run over: the answer is None, not an exception."""
        broken = Path(self.tmp.name) / "memento" / "broken.db"
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_bytes(b"a store that isn't one")
        self.assertIsNone(chats.pin(broken, "s"))

    def test_a_pick_is_named_the_same_way_wherever_it_rides(self):
        pick = {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"}
        self.assertEqual(
            chats.pin_fields(pick),
            {"model": "anthropic/claude-sonnet-4.5", "provider": "openrouter"},
        )
        self.assertEqual(chats.pin_fields(pick, choice=True), {"modelChoice": pick})
        self.assertEqual(chats.pin_fields(None), {}, "a session that keeps none names none")
        self.assertEqual(chats.pin_fields(None, choice=True), {})

    def test_a_pick_written_onto_a_record_round_trips_through_choice(self):
        """A thread that pins at its next send reads back as pinned, its record otherwise intact."""
        self.merge("t1", {"hermesSessionId": "s", "title": "A chat", "updatedAt": 1})
        chats.set_choice(self.path, "t1", {"provider": "deepseek", "model": "deepseek-v4-pro"})
        found = chats.by_session(self.path, "s")
        self.assertEqual(chats.choice(found), {"provider": "deepseek", "model": "deepseek-v4-pro"})
        self.assertEqual(found["value"]["title"], "A chat", "the rest of the record is kept")

    def test_the_write_beats_the_records_own_clock(self):
        # A record whose clock runs ahead of this host's still takes the pick: the merge keeps the
        # newer of the two, so the write has to be past it.
        self.merge("t1", {"hermesSessionId": "s"}, at=10**13)
        chats.set_choice(self.path, "t1", {"provider": "deepseek", "model": "deepseek-v4-pro"})
        self.assertEqual(
            chats.choice(chats.one(self.path, "t1")),
            {"provider": "deepseek", "model": "deepseek-v4-pro"},
        )

    def test_a_record_that_is_not_there_takes_no_pick(self):
        chats.set_choice(self.path, "missing", {"provider": "deepseek", "model": "deepseek-v4-pro"})
        self.assertEqual(chats.read(self.path), {}, "nothing to pin, and nothing invented")

    def test_a_home_with_no_store_is_no_pin_and_stays_that_way(self):
        missing = Path(self.tmp.name) / "elsewhere" / "memento.db"
        self.assertIsNone(chats.pin(missing, "s"))
        self.assertFalse(missing.exists(), "reading a pin never makes a store")

    def test_one_session_is_found_without_decoding_the_whole_list(self):
        """The delegation sweep asks this per conversation every 5 seconds.

        So the answer is read off the row that names the session, not by decoding every app chat
        in the store — which is what "walk the list and find one" costs per conversation, per look.
        """
        for number in range(50):
            self.merge(f"chat-{number}", {"hermesSessionId": f"other-{number}", "title": "x"}, at=1)
        self.merge(
            "chat-target",
            {
                "hermesSessionId": "memento-target",
                "modelChoice": {"provider": "deepseek", "model": "d"},
            },
            at=2,
        )
        with mock.patch.object(
            chats, "_records", side_effect=AssertionError("the whole list was read")
        ):
            found = chats.by_session(self.path, "memento-target")
        self.assertEqual(chats.choice(found), {"provider": "deepseek", "model": "d"})


if __name__ == "__main__":
    unittest.main()
