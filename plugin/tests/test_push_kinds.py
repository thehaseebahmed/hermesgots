"""Which pushes a device asked for, and the news that produces them.

Run: python3 -m unittest plugin.tests.test_push_kinds -v
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

from plugin import alerts, chats, delegation, link, push, sessions
from plugin.store import connect, db_path
from plugin.tests._helpers import subscribed


class Categories(unittest.TestCase):
    def test_an_older_subscription_wants_what_it_always_got(self):
        row = {"categories": None}
        for category in ("chat_input", "code_input"):
            self.assertTrue(push.wants(row, category))
        for category in ("chat_run_done", "code_run_failed", "routine_failed"):
            self.assertFalse(push.wants(row, category))

    def test_a_subscription_wants_only_what_it_listed(self):
        row = {"categories": '["code_run_failed"]'}
        self.assertTrue(push.wants(row, "code_run_failed"))
        self.assertFalse(push.wants(row, "chat_run_failed"))
        self.assertFalse(push.wants(row, "chat_input"))

    def test_unknown_categories_are_dropped(self):
        self.assertEqual(
            push.clean_categories(["code_input", "nonsense", "chat_run_done"]),
            ["chat_run_done", "code_input"],
        )
        self.assertIsNone(push.clean_categories(None))
        self.assertEqual(push.clean_categories([]), [])

    def test_a_kind_belongs_to_the_feature_of_its_session(self):
        self.assertEqual(push.category_of("question"), "chat_input")
        self.assertEqual(push.category_of("question", project=True), "code_input")
        self.assertEqual(push.category_of("plan"), "code_input")
        self.assertEqual(push.category_of("run_failed"), "chat_run_failed")
        self.assertEqual(push.category_of("run_done", project=True), "code_run_done")
        self.assertEqual(push.category_of("run_done"), "chat_run_done")
        self.assertEqual(push.category_of("clone_failed"), "code_setup_failed")
        self.assertEqual(push.category_of("routine_failed"), "routine_failed")
        self.assertEqual(push.category_of("research_brief"), "research_input")
        self.assertEqual(push.category_of("research_scope"), "research_input")
        self.assertEqual(push.category_of("research_done", project=True), "research_done")
        self.assertEqual(push.category_of("research_failed"), "research_failed")
        self.assertEqual(push.category_of("meeting_done"), "meeting_done")
        self.assertEqual(push.category_of("meeting_failed", project=True), "meeting_failed")

    def test_a_room_that_needs_the_user_is_a_category_of_its_own(self):
        self.assertEqual(push.category_of("room_input"), "room_input")
        self.assertEqual(push.category_of("room_input", project=True), "room_input")
        self.assertIn("room_input", push.CATEGORIES)
        self.assertIn("room_input", push.KINDS)

    def test_every_kind_lands_in_a_category_that_exists(self):
        for kind in push.KINDS:
            for project in (False, True):
                self.assertIn(push.category_of(kind, project), push.CATEGORIES)

    def test_the_registry_and_the_app_keep_the_same_lists(self):
        import re

        app = Path(__file__).resolve().parents[2] / "app"
        fcm = (app / "netlify" / "lib" / "fcm.ts").read_text()
        kinds = re.search(r"PUSH_KINDS = \[(.*?)\]", fcm, re.S).group(1)
        categories = re.search(r"PUSH_CATEGORIES = \[(.*?)\]", fcm, re.S).group(1)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', kinds)), push.KINDS)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', categories)), push.CATEGORIES)
        kinds_ts = (app / "src" / "lib" / "push-kinds.ts").read_text()
        listed = re.search(r"export type PushCategory =(.*?)\n\n", kinds_ts, re.S).group(1)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', listed)), push.CATEGORIES)
        worker = (app / "public" / "push-sw.js").read_text()
        words = re.search(r"const WORDS = \{(.*?)\}", worker, re.S).group(1)
        self.assertEqual(tuple(re.findall(r"^\s*(\w+):", words, re.M)), push.KINDS)
        # The same event read out of a closed app and out of an open page is one sentence, or the two
        # ways a device hears about it disagree.
        said = re.search(r"const WORDS[^{]*\{(.*?)\n\}", fcm, re.S).group(1)
        theirs = dict(re.findall(r'(\w+): "([^"]*)"', said))
        theirs.pop("test", None)  # the registry's own probe, which no device is told
        self.assertEqual(
            dict(re.findall(r'(\w+): "([^"]*)"', words)),
            theirs,
            "the registry and the worker say the same words",
        )

    def test_a_database_from_before_categories_gains_the_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gots.db"
            old = sqlite3.connect(path)
            old.execute(
                """CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, device TEXT NOT NULL,
                   p256dh TEXT NOT NULL, auth TEXT NOT NULL, vapid_key TEXT NOT NULL,
                   subject TEXT NOT NULL, created_at INTEGER NOT NULL)"""
            )
            old.execute("PRAGMA user_version = 13")
            old.commit()
            old.close()
            conn = connect(path)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(push_subscriptions)")}
            conn.close()
            self.assertIn("categories", columns)

    def test_once_tells_a_thing_a_single_time_until_cleared(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gots.db"
            self.assertTrue(push.once(path, "a"))
            self.assertFalse(push.once(path, "a"))
            self.assertTrue(push.once(path, "b"))
            push.clear(path, "a")
            self.assertTrue(push.once(path, "a"))


class Delivery(unittest.TestCase):
    """Who hears a push: a device that asked for its category, and never one with the app on screen."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))
        subscribed(self.path, '["room_input"]')
        self.sent = []
        patch = mock.patch.object(
            push, "send", lambda row, payload, topic: self.sent.append(payload) or 201
        )
        patch.start()
        self.addCleanup(patch.stop)
        relay = mock.patch.object(push, "_relay", lambda *args, **kwargs: None)
        relay.start()
        self.addCleanup(relay.stop)

    def deliver(self):
        push._deliver(self.path, "room_input", "room_input", "room-1", {"title": "Planning"})

    def test_a_waiting_room_reaches_a_device_that_asked_for_it(self):
        self.deliver()
        self.assertEqual(
            self.sent,
            [{"kind": "room_input", "session_id": "room-1", "title": "Planning"}],
            "the room's id, so a tap opens it, and its name, so the notification says which",
        )

    def test_a_device_with_the_app_on_screen_is_not_pushed(self):
        with push.watching(self.path, "phone-1"):
            self.deliver()
            self.assertEqual(self.sent, [], "the app is already drawing the room")
        self.deliver()
        self.assertEqual(len(self.sent), 1, "put away, it hears it then")


class Scope(unittest.TestCase):
    """Which sessions a profile pushes for: the app's own chats, and no other surface's.

    Gots mints every chat's Hermes session id with a prefix of its own (``sessions.ID_PREFIXES``),
    and compression moves the chat onto a child session that carries none — so a chat is found from
    its ancestors, the ancestry the rest of a push reads too (the chat's title, its mute, and
    ``alerts.turn_finished`` counting its subagents as its own work).
    """

    # A push is delivered on a daemon thread; a local store answers in milliseconds, and a wait this
    # long that hears nothing is what says nothing arrived.
    WAIT_S = 1.0

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.path = db_path(self.home)
        subscribed(self.path, '["chat_input"]')
        self.sent = []
        self.arrived = threading.Event()

        def send(row, payload, topic):
            self.sent.append(payload)
            self.arrived.set()
            return 201

        send_patch = mock.patch.object(push, "send", send)
        send_patch.start()
        self.addCleanup(send_patch.stop)
        relay = mock.patch.object(push, "_relay", lambda *args, **kwargs: None)
        relay.start()
        self.addCleanup(relay.stop)

    def tell(self, kind, session_id):
        """What ``notify`` answered, and the pushes that reached the wire."""
        self.sent.clear()
        self.arrived.clear()
        answer = push.notify(kind, session_id, path=self.path)
        if answer:
            # A False answer started no thread, so nothing can still be on its way.
            self.arrived.wait(self.WAIT_S)
        return answer, self.sent

    # Hermes's own store: the columns the ancestry walk reads, and the title that makes a row the
    # profile's Bot Chat.
    SCHEMA = (
        "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, parent_session_id TEXT,"
        " end_reason TEXT, model_config TEXT, source TEXT, title TEXT, archived INTEGER,"
        " hidden INTEGER, started_at REAL)"
    )

    def lineage(self, rows):
        """Hermes's own store, with the parent links compression leaves behind.

        ``model_config`` and ``source`` are the columns ``sessions._forks`` reads, so a case can
        make a session a fork of its parent rather than the chat's continuation.
        """
        conn = sqlite3.connect(self.home / "state.db")
        conn.execute(self.SCHEMA)
        conn.executemany(
            "INSERT INTO sessions (id, parent_session_id, end_reason, model_config, source)"
            " VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
        conn.close()

    def bot_chat(self, session_id="sess_main", archived=0):
        """The row Hermes keeps titled ``"Bot Chat"``: the profile's canonical chat, and Main."""
        conn = sqlite3.connect(self.home / "state.db")
        conn.execute(self.SCHEMA)
        conn.execute(
            "INSERT INTO sessions (id, title, archived) VALUES (?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET title = excluded.title, archived = excluded.archived",
            (session_id, chats.BOT_CHAT_TITLE, archived),
        )
        conn.commit()
        conn.close()

    def test_a_gots_chats_session_is_pushed(self):
        answer, sent = self.tell("question", "gots-abc")
        self.assertTrue(answer)
        self.assertEqual(sent, [{"kind": "question", "session_id": "gots-abc"}])

    def test_a_chats_own_id_is_answered_without_opening_the_store(self):
        # The predicate answers the app's own prefix first, and the push gate adds no branch of
        # its own: neither opens state.db for a chat the app minted.
        with mock.patch.object(sessions, "_open_state") as store:
            self.assertTrue(sessions.is_chat(self.home, "gots-abc"))
        store.assert_not_called()
        with mock.patch.object(sessions, "_open_state") as store, mock.patch.object(push, "_run"):
            answer = push.notify("question", "gots-abc", path=self.path)
        self.assertTrue(answer, "the app minted the id, so the chat is its own")
        store.assert_not_called()

    def test_another_surfaces_session_is_not_pushed(self):
        # No prefix, no chat record, no compression parent: a session Gots never started.
        answer, sent = self.tell("question", "sess_9f2c41")
        self.assertFalse(answer, "no device is told about a session the app doesn't own")
        self.assertEqual(sent, [])

    def test_a_compressed_chats_child_session_is_pushed(self):
        self.lineage([
            ("gots-abc", None, "compression", None, None),
            ("sess_c0ffee", "gots-abc", None, None, None),
        ])
        answer, sent = self.tell("question", "sess_c0ffee")
        self.assertTrue(answer, "the child's root is the chat's, so the chat is being pushed")
        self.assertEqual(sent, [{"kind": "question", "session_id": "sess_c0ffee"}])

    def test_a_subagents_session_is_pushed_as_its_chats(self):
        chats.merge(
            self.path,
            {
                "chat-1": {
                    "at": 1,
                    "value": {"hermesSessionId": "gots-abc", "title": "Refactor the parser"},
                }
            },
        )
        self.lineage([
            ("gots-abc", None, "compression", None, None),
            ("sess_de1e", "gots-abc", None, '{"_delegate_from": "gots-abc"}', "subagent"),
        ])
        answer, sent = self.tell("question", "sess_de1e")
        self.assertTrue(answer, "the chat started it, so its question is the chat's news")
        self.assertEqual(
            sent,
            [{"kind": "question", "session_id": "sess_de1e", "title": "Refactor the parser"}],
            "the child's id, under the chat's own title",
        )

    def test_a_subagents_session_of_another_surface_is_not_pushed(self):
        self.lineage([
            ("sess_9f2c41", None, None, None, None),
            ("sess_de1e", "sess_9f2c41", None, '{"_delegate_from": "sess_9f2c41"}', "subagent"),
        ])
        answer, sent = self.tell("question", "sess_de1e")
        self.assertFalse(answer, "no ancestor is the app's, so it is no device's news")
        self.assertEqual(sent, [])

    def test_a_turn_in_the_profiles_bot_chat_is_pushed(self):
        # Main is Hermes's own conversation, so its id carries no prefix of the app's: the
        # profile's canonical Bot Chat is the other answer a chat's session is found by (G2).
        self.bot_chat()
        answer, sent = self.tell("question", "sess_main")
        self.assertTrue(answer, "a turn in Main is the bot's own news")
        self.assertEqual(
            sent,
            [{"kind": "question", "session_id": "sess_main", "title": chats.BOT_CHAT_TITLE}],
            "the session, and the host's own word for the chat it is",
        )

    def test_a_compaction_or_a_fork_of_main_is_still_mains(self):
        # The two shapes the walk already follows: a chat a compaction moved onto a child
        # session, and a session a subagent forked off it.
        self.lineage([
            ("sess_main", None, "compression", None, None),
            ("sess_c0ffee", "sess_main", None, None, None),
            ("sess_de1e", "sess_main", None, '{"_delegate_from": "sess_main"}', "subagent"),
        ])
        self.bot_chat()
        for child in ("sess_c0ffee", "sess_de1e"):
            answer, sent = self.tell("question", child)
            self.assertTrue(answer, "%s's ancestry reaches Main, so its turn is Main's" % child)
            self.assertEqual(
                sent,
                [{"kind": "question", "session_id": child, "title": chats.BOT_CHAT_TITLE}],
                "the child's id, under the chat Main's ancestry names",
            )

    def test_a_bot_chat_archived_on_the_dashboard_is_not_main(self):
        # An archived Bot Chat is a retired Main — ``sessions.bot_chat`` answers nothing for it —
        # so its turns are another conversation's news until the host names a replacement.
        self.bot_chat(archived=1)
        answer, sent = self.tell("question", "sess_main")
        self.assertFalse(answer)
        self.assertEqual(sent, [])

    def test_a_store_that_cannot_be_read_drops_the_push(self):
        self.lineage([
            ("gots-abc", None, "compression", None, None),
            ("sess_c0ffee", "gots-abc", None, None, None),
        ])
        (self.home / "state.db").write_bytes(b"not a database")
        answer, sent = self.tell("question", "sess_c0ffee")
        self.assertFalse(answer, "a store that can't answer is not read as 'not a chat'")
        self.assertEqual(sent, [], "fail closed: nothing is sent on a guess")

    def test_a_held_store_drops_the_push_without_holding_the_hook(self):
        self.lineage([
            ("gots-abc", None, "compression", None, None),
            ("sess_c0ffee", "gots-abc", None, None, None),
        ])
        holder = sqlite3.connect(self.home / "state.db", isolation_level=None)
        holder.execute("BEGIN EXCLUSIVE")
        holder.execute("INSERT INTO sessions (id) VALUES ('writer')")
        try:
            started = time.monotonic()
            answer, sent = self.tell("question", "sess_c0ffee")
            elapsed = time.monotonic() - started
        finally:
            holder.execute("ROLLBACK")
            holder.close()
        self.assertFalse(answer, "the store won't say, so the push drops as it always did")
        self.assertEqual(sent, [])
        self.assertLess(elapsed, 1.0, "one short read: a held store doesn't stall the hook thread")


class Mutes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = db_path(Path(self.tmp.name))
        self.parents = {}
        patch = mock.patch("plugin.sessions._parent_of", lambda home, sid: self.parents.get(sid))
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)

    def chat(self, chat_id, session, muted=None):
        value = {"hermesSessionId": session, "title": "t", "createdAt": 1, "updatedAt": 1}
        if muted is not None:
            value["muted"] = muted
        chats.merge(self.path, {chat_id: {"at": 1, "value": value}})

    def test_nothing_is_muted_by_default(self):
        self.chat("a", "gots-a")
        self.assertFalse(push.muted(self.path, "question", "gots-a"))

    def test_a_muted_bot_mutes_everything_it_would_say(self):
        push.set_bot_muted(self.path, True)
        for kind in ("question", "run_failed", "routine_failed", "clone_failed"):
            self.assertTrue(push.muted(self.path, kind, "x"))
        push.set_bot_muted(self.path, False)
        self.assertFalse(push.muted(self.path, "routine_failed", "x"))

    def test_a_muted_thread_mutes_its_own_session_only(self):
        self.chat("a", "gots-a", muted=True)
        self.chat("b", "gots-b")
        self.assertTrue(push.muted(self.path, "approval", "gots-a"))
        self.assertTrue(push.muted(self.path, "run_done", "gots-a"))
        self.assertFalse(push.muted(self.path, "approval", "gots-b"))
        # Not about a session: a thread's mute has no say.
        self.assertFalse(push.muted(self.path, "routine_failed", "gots-a"))

    def test_a_compressed_session_is_still_its_chats(self):
        self.chat("a", "gots-a", muted=True)
        self.parents["child"] = "gots-a"
        self.assertTrue(push.muted(self.path, "question", "child"))

    def test_unmuting_a_thread_clears_it(self):
        self.chat("a", "gots-a", muted=True)
        chats.merge(
            self.path,
            {"a": {"at": 2, "value": {"hermesSessionId": "gots-a", "title": "t", "createdAt": 1, "updatedAt": 1}}},
        )
        self.assertFalse(push.muted(self.path, "question", "gots-a"))


class Messages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = db_path(Path(self.tmp.name))
        self.parents = {}
        patch = mock.patch("plugin.sessions._parent_of", lambda home, sid: self.parents.get(sid))
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)
        self.sent = []
        deliver = mock.patch.object(
            push, "_deliver", lambda path, kind, category, sid, extra=None: self.sent.append(extra)
        )
        deliver.start()
        self.addCleanup(deliver.stop)

    def state(self, rows):
        conn = sqlite3.connect(Path(self.tmp.name) / "state.db")
        conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, parent_session_id TEXT)")
        conn.executemany("INSERT INTO sessions (id, title) VALUES (?, ?)", rows)
        conn.commit()
        conn.close()

    def test_a_session_push_carries_its_chats_title(self):
        chats.merge(self.path, {"a": {"at": 1, "value": {"hermesSessionId": "gots-a", "title": "Trip to Lahore"}}})
        push._run(self.path, "question", "gots-a")
        self.assertEqual(self.sent, [{"title": "Trip to Lahore"}])

    def test_a_compressed_session_carries_its_chats_title(self):
        chats.merge(self.path, {"a": {"at": 1, "value": {"hermesSessionId": "gots-a", "title": "Trip"}}})
        self.parents["child"] = "gots-a"
        push._run(self.path, "run_done", "child")
        self.assertEqual(self.sent[0]["title"], "Trip")

    def test_a_chat_the_app_hasnt_synced_takes_hermess_title(self):
        self.state([("gots-b", "Fix the login bug")])
        push._run(self.path, "approval", "gots-b")
        self.assertEqual(self.sent, [{"title": "Fix the login bug"}])

    def test_without_any_title_none_is_sent(self):
        push._run(self.path, "approval", "gots-c")
        self.assertEqual(self.sent, [{}])

    def test_a_long_title_is_cut(self):
        push._run(self.path, "routine_failed", "job", title="word " * 40)
        title = self.sent[0]["title"]
        self.assertLessEqual(len(title), push.TITLE_MAX)
        self.assertTrue(title.endswith("…"))

    def test_the_bot_rides_along(self):
        push.set_bot(self.path, "penny")
        push._run(self.path, "run_done", "gots-d")
        self.assertEqual(self.sent, [{"bot": "penny"}])

    def test_only_a_bot_id_is_kept(self):
        with self.assertRaises(push.PushError):
            push.set_bot(self.path, "../etc")
        self.assertIsNone(push.bot(self.path))


class Turns(unittest.TestCase):
    def setUp(self):
        alerts._started.clear()
        alerts._held.clear()
        self.told = []
        self.patches = [
            mock.patch.object(push, "notify", lambda kind, sid, path=None, **_: self.told.append((kind, sid))),
            mock.patch.object(alerts.sessions, "_paths", lambda: (Path("/nonexistent/m.db"), Path("/x"))),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()

    def end(self, session="gots-1", **flags):
        alerts.turn_finished(session_id=session, platform="api_server", **flags)

    def test_a_failed_turn_is_told_at_once(self):
        alerts.turn_started(session_id="gots-1", platform="api_server")
        self.end(completed=False, failed=True, interrupted=False)
        self.assertEqual(self.told, [("run_failed", "gots-1")])

    def test_a_stopped_turn_is_not_a_failure(self):
        alerts.turn_started(session_id="gots-1", platform="api_server")
        self.end(completed=False, failed=True, interrupted=True)
        self.assertEqual(self.told, [])

    def test_a_short_turn_that_finished_is_not_news(self):
        alerts.turn_started(session_id="gots-1", platform="api_server")
        self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [])

    def test_a_long_turn_that_finished_is(self):
        alerts._started["gots-1"] = time.monotonic() - alerts.RUN_DONE_MIN_S - 1
        self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [("run_done", "gots-1")])

    def test_a_turn_whose_subagents_still_work_is_not_finished_yet(self):
        alerts._started["gots-1"] = time.monotonic() - alerts.RUN_DONE_MIN_S - 1
        with mock.patch.object(delegation, "live_sessions", lambda home: {"gots-1": 1}):
            self.end(completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [])

    def test_that_turn_is_told_once_its_subagents_are_gone(self):
        alerts._started["gots-1"] = time.monotonic() - alerts.RUN_DONE_MIN_S - 1
        with mock.patch.object(delegation, "live_sessions", lambda home: {"gots-1": 1}):
            self.end(completed=True, failed=False, interrupted=False)
            self.assertEqual(self.told, [], "the news waits while the run still has work")
        with mock.patch.object(delegation, "live_sessions", lambda home: {}):
            alerts.tell_finished(*alerts.sessions._paths())
        self.assertEqual(self.told, [("run_done", "gots-1")])

    def test_a_turn_held_for_its_subagents_is_told_only_once(self):
        alerts._started["gots-1"] = time.monotonic() - alerts.RUN_DONE_MIN_S - 1
        with mock.patch.object(delegation, "live_sessions", lambda home: {"gots-1": 1}):
            self.end(completed=True, failed=False, interrupted=False)
        with mock.patch.object(delegation, "live_sessions", lambda home: {}):
            alerts.tell_finished(*alerts.sessions._paths())
            alerts.tell_finished(*alerts.sessions._paths())
        self.assertEqual(self.told, [("run_done", "gots-1")])

    def test_a_failure_is_told_at_once_whatever_its_subagents_do(self):
        alerts._started["gots-1"] = time.monotonic() - alerts.RUN_DONE_MIN_S - 1
        with mock.patch.object(delegation, "live_sessions", lambda home: {"gots-1": 1}):
            self.end(completed=False, failed=True, interrupted=False)
        self.assertEqual(self.told, [("run_failed", "gots-1")])

    def test_a_session_of_another_surface_is_ignored(self):
        alerts._started["telegram-9"] = time.monotonic() - 1000
        self.end(session="telegram-9", completed=True, failed=False, interrupted=False)
        self.assertEqual(self.told, [])

    def test_a_delegated_childs_failure_is_told_as_its_chats(self):
        # A subagent's turn ends in a session of its own, with no project record: the chat
        # started it, so its failure is the chat's news (sessions.is_chat follows the fork).
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        conn = sqlite3.connect(home / "state.db")
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT,"
            " model_config TEXT, source TEXT)"
        )
        conn.executemany(
            "INSERT INTO sessions (id, parent_session_id, end_reason, model_config, source)"
            " VALUES (?, ?, ?, ?, ?)",
            [
                ("gots-1", None, "compression", None, None),
                ("sess_de1e", "gots-1", None, '{"_delegate_from": "gots-1"}', "subagent"),
            ],
        )
        conn.commit()
        conn.close()
        with mock.patch.object(
            alerts.sessions, "_paths", lambda: (Path("/nonexistent/m.db"), home)
        ):
            self.end(session="sess_de1e", completed=False, failed=True, interrupted=False)
        self.assertEqual(self.told, [("run_failed", "sess_de1e")])


class Routines(unittest.TestCase):
    def run_pass(self, rows, now):
        cron = types.ModuleType("cron")
        executions = types.ModuleType("cron.executions")
        executions.list_executions = lambda job_id=None, limit=3: rows
        jobs = types.ModuleType("cron.jobs")
        jobs.list_jobs = lambda include_disabled=True: [{"id": "job1"}]
        told = []
        with tempfile.TemporaryDirectory() as tmp:
            path = db_path(Path(tmp))
            with mock.patch.dict(
                sys.modules, {"cron": cron, "cron.executions": executions, "cron.jobs": jobs}
            ):
                with mock.patch.object(push, "notify", lambda kind, sid, path=None, **_: told.append((kind, sid))):
                    first = alerts.check_routines(path, now)
                    second = alerts.check_routines(path, now)
        return first, second, told

    def test_a_fresh_failure_is_told_once(self):
        now = time.time()
        finished = (datetime.now().astimezone() - timedelta(minutes=2)).isoformat()
        rows = [{"id": "r1", "status": "failed", "finished_at": finished}]
        first, second, told = self.run_pass(rows, now)
        self.assertEqual((first, second), (1, 0))
        self.assertEqual(told, [("routine_failed", "job1")])

    def test_an_old_failure_and_a_good_run_are_not_news(self):
        now = time.time()
        old = (datetime.now().astimezone() - timedelta(hours=5)).isoformat()
        fresh = (datetime.now().astimezone() - timedelta(minutes=2)).isoformat()
        rows = [
            {"id": "r1", "status": "failed", "finished_at": old},
            {"id": "r2", "status": "completed", "finished_at": fresh},
        ]
        first, _, told = self.run_pass(rows, now)
        self.assertEqual(first, 0)
        self.assertEqual(told, [])

    def test_a_delivery_that_failed_after_a_good_run_counts(self):
        now = time.time()
        fresh = (datetime.now().astimezone() - timedelta(minutes=2)).isoformat()
        rows = [{"id": "r3", "status": "completed", "delivery_outcome": "failed", "finished_at": fresh}]
        first, _, _ = self.run_pass(rows, now)
        self.assertEqual(first, 1)


if __name__ == "__main__":
    unittest.main()


class OnScreen(unittest.TestCase):
    """A device whose app is on screen is skipped: its stream is open, so it already knows.

    The app matches a push to the screen it is about, and only answers it when that screen is
    opened; a device the Host tells anyway reads the tray twice for news it has already drawn. The
    skip is the stream's, never the account's, and a stream that closes puts the device back on the
    list.
    """

    def test_only_a_device_whose_stream_is_open_is_skipped(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "gots.db"
            self.assertEqual(push._on_screen_devices(path), [], "an app that is closed is told")
            with push.watching(path, "phone-1"):
                self.assertEqual(push._on_screen_devices(path), ["phone-1"])
            self.assertEqual(
                push._on_screen_devices(path), [], "a stream that closed is told again"
            )

    def test_two_streams_of_one_device_hold_it_on_screen_until_both_close(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "gots.db"
            with push.watching(path, "phone-1"):
                with push.watching(path, "phone-1"):
                    self.assertEqual(push._on_screen_devices(path), ["phone-1"])
                self.assertEqual(
                    push._on_screen_devices(path), ["phone-1"], "the stream still open holds it"
                )
            self.assertEqual(push._on_screen_devices(path), [])

    def test_the_relay_carries_the_skip_list_to_the_registry(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "gots.db"
            bodies = []
            state = {"token": "token", "site": "https://app.example"}

            def call(site, method, route, **kwargs):
                bodies.append(kwargs.get("body"))
                return {}

            with push.watching(path, "phone-1"), mock.patch.object(
                push.link, "load_state", lambda home: state
            ), mock.patch.object(push.link, "call", call):
                push._relay(path, "chat_input", "chat_input", "gots-1", {})
            self.assertEqual(
                bodies,
                [
                    {
                        "kind": "chat_input",
                        "category": "chat_input",
                        "session_id": "gots-1",
                        "skip": ["phone-1"],
                    }
                ],
                "the phone whose app is open is the one the registry leaves out",
            )

    def test_the_relay_tells_the_registry_which_bot_and_picture_it_is(self):
        # A phone draws the notice itself — a notification payload can carry no button — so it is
        # told the bot whose picture to wear, where that picture is, and the buttons to draw.
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "gots.db"
            bodies = []
            state = {"token": "token", "site": "https://app.example"}

            def call(site, method, route, **kwargs):
                bodies.append(kwargs.get("body"))
                return {}

            push.set_bot(path, "nova")
            push.set_web(path, "https://hermesgots.dev")
            notice = push.Notice(
                title="Fix the build",
                body="rm -rf ./build",
                bot="nova",
                actions=(push.Action("Allow once", "https://bot.example/once"),),
            )
            with mock.patch.object(push.link, "load_state", lambda home: state), mock.patch.object(
                push.link, "call", call
            ):
                push._relay(path, "approval", "chat_input", "gots-1", notice)
            self.assertEqual(bodies[0]["bot"], "nova", "the phone's entry wears this bot's picture")
            self.assertEqual(
                bodies[0]["icon"],
                "https://hermesgots.dev/bots/nova/happy.png",
                "the bot's plain face: Android badges it with the app's icon itself, so the "
                "badged copy the browser's tray and ntfy read would wear the mark twice",
            )
            self.assertEqual(
                bodies[0]["actions"],
                [{"label": "Allow once", "url": "https://bot.example/once"}],
                "the button a press posts back",
            )


class TheCharm(unittest.TestCase):
    """Which bot a push is for, and one word for why: the charm's own two fields.

    The charm holds one record — a bot's face and one of three reasons — so the relay names this
    profile's registry bot id and the reason for the three moments a bot is waiting on the reader.
    A plan waiting is an approval; every other kind is news about something that is not a bot's face
    on the charm, and carrying a reason it has no word for would make the charm draw a lie. A clear
    names its subject and nothing else: a clear is not a moment, it is the end of one.
    """

    PROFILE = "work"
    REASONS = ("finished", "approval", "question")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "gots.db"
        self.state = {"token": "token", "site": "https://app.example", "hostId": "host-1"}

    def relayed(self, kind, state=None):
        """The body the relay posts to the registry for one kind of news."""
        bodies = []

        def call(site, method, route, **kwargs):
            bodies.append(kwargs.get("body"))
            return {}

        with mock.patch.object(
            push.link, "load_state", lambda home: state or self.state
        ), mock.patch.object(push.link, "call", call):
            push._relay(self.path, kind, "chat_input", "gots-1", {})
        self.assertEqual(len(bodies), 1, "a linked profile tells the registry once")
        return bodies[0]

    def test_a_push_names_the_bot_the_charm_holds_and_its_reason(self):
        self.state["botId"] = link.bot_id(self.state, self.PROFILE)
        body = self.relayed("question")
        self.assertEqual(
            body["charm"],
            link.bot_id(self.state, self.PROFILE),
            "the id `link.bot_id` computes, which the charm's own bots are named by",
        )
        self.assertEqual(body["charm_reason"], "question")

    def test_a_plan_waiting_is_an_approval(self):
        self.state["botId"] = link.bot_id(self.state, self.PROFILE)
        self.assertEqual(self.relayed("plan")["charm_reason"], "approval")

    def test_a_finished_run_is_finished(self):
        self.state["botId"] = link.bot_id(self.state, self.PROFILE)
        self.assertEqual(self.relayed("run_done")["charm_reason"], "finished")

    def test_only_the_three_moments_are_a_bot_on_the_charm(self):
        self.state["botId"] = link.bot_id(self.state, self.PROFILE)
        moments = {
            "approval": "approval",
            "plan": "approval",
            "question": "question",
            "run_done": "finished",
        }
        for kind in push.KINDS:
            body = self.relayed(kind)
            with self.subTest(kind=kind):
                if kind in moments:
                    self.assertEqual(body["charm"], self.state["botId"])
                    self.assertEqual(body["charm_reason"], moments[kind])
                else:
                    self.assertNotIn("charm", body, "not a bot's face on the charm")
                    self.assertNotIn("charm_reason", body, "not a bot's face on the charm")

    def test_a_reason_is_only_ever_one_of_the_three(self):
        self.state["botId"] = link.bot_id(self.state, self.PROFILE)
        for kind in push.KINDS:
            reason = self.relayed(kind).get("charm_reason")
            if reason is not None:
                with self.subTest(kind=kind):
                    self.assertIn(reason, self.REASONS, "the charm draws one of three words")

    def test_a_link_that_holds_no_bot_id_names_none(self):
        body = self.relayed("question")
        self.assertNotIn("charm", body, "an id this profile never computed is not guessed at")
        self.assertNotIn("charm_reason", body, "a reason without a bot it belongs to")

    def test_a_clear_names_no_reason(self):
        subscribed(self.path, '["chat_input"]')
        sent, told = [], []

        def call(site, method, route, **kwargs):
            told.append((route, kwargs.get("body")))
            return {}

        with mock.patch.object(
            push, "send", lambda row, payload, topic: sent.append(payload) or 201
        ), mock.patch.object(push.link, "load_state", lambda home: self.state), mock.patch.object(
            push.link, "call", call
        ):
            push.dismissed(self.path, "gots-1")
        self.assertEqual(
            sent,
            [{"kind": "clear", "session_id": "gots-1"}],
            "a clear is the end of a moment, not one: it names what to clear and no reason",
        )
        self.assertEqual(told, [("push/dismiss", {"session_id": "gots-1"})])
