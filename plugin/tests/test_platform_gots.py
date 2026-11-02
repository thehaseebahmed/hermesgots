"""A routine's answer, delivered into a chat as the bot's own message (ADR 0081).

The seams are Hermes's own: the adapter's ``send()`` with routing metadata, and the scheduler's
standalone sender with none. Hermes's session store is faked at its own boundary — the methods the
plugin calls — and the plugin's store and ``state.db`` are real files, so a message's row, the queue
and the route's read are exercised as they are written.

Run: python3 -m unittest plugin.tests.test_platform_gots -v
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import chats, platform_gots
from plugin.store import connect, db_path

CHAT = "main-bot"
SESSION = "memento-main-bot"
WRAPPED = (
    "Cronjob Response: Morning watch\n"
    "(job_id: job-1)\n"
    "-------------\n\n"
    "The tide turns at 06:40.\n\n"
    "To stop or manage this job, send me a new message (e.g. \"stop reminder Morning watch\")."
)


def _host():
    """The Hermes modules the plugin reaches lazily, as this test needs them."""

    class BasePlatformAdapter:
        supports_async_delivery = True

        def __init__(self, config=None, platform=None):
            self.config = config
            self.platform = platform

        def _mark_connected(self):
            self.connected = True

    class Platform(str):
        pass

    class SendResult:
        def __init__(self, success=True, error=None, message_id=None):
            self.success = success
            self.error = error
            self.message_id = message_id

    send_targets = types.ModuleType("gateway.platforms.send_targets")
    send_targets.parse_nonempty = lambda ref: (ref.strip(), None) if ref.strip() else None
    base = types.ModuleType("gateway.platforms.base")
    base.BasePlatformAdapter = BasePlatformAdapter
    base.SendResult = SendResult
    platforms = types.ModuleType("gateway.platforms")
    platforms.base = base
    platforms.send_targets = send_targets
    config = types.ModuleType("gateway.config")
    config.Platform = Platform
    gateway = types.ModuleType("gateway")
    gateway.config = config
    gateway.platforms = platforms
    return {
        "gateway": gateway,
        "gateway.config": config,
        "gateway.platforms": platforms,
        "gateway.platforms.base": base,
        "gateway.platforms.send_targets": send_targets,
    }


class FakeStore:
    """Hermes's session store, at the boundary the plugin uses."""

    def __init__(self, home: Path, *, busy: bool = False):
        self.home = home
        self.busy = busy
        self.rows = []
        self.leases = {}
        self.runs = []

    # -- the turn lease ---------------------------------------------------
    def try_acquire_session_turn_lease(self, session_id, holder, *, ttl_seconds=300.0):
        if self.busy:
            return False
        self.leases[session_id] = holder
        return True

    def release_session_turn_lease(self, session_id, holder):
        if self.leases.get(session_id) == holder:
            self.leases.pop(session_id, None)

    # -- the transcript ---------------------------------------------------
    def resolve_resume_session_id(self, session_id):
        return session_id

    def list_cron_job_runs(self, job_id, limit=20):
        return [run for run in self.runs if run.get("cron_job_id") in (None, job_id)][:limit]

    def append_message(self, session_id, role, content=None, display_kind=None,
                       display_metadata=None, turn_lease_holder=None, finish_reason=None, **kwargs):
        conn = sqlite3.connect(self.home / "state.db", isolation_level=None)
        try:
            cursor = conn.execute(
                """INSERT INTO messages (session_id, role, content, timestamp, display_kind,
                                         display_metadata, finish_reason)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (session_id, role, content, time.time(), display_kind,
                 json.dumps(display_metadata) if display_metadata else None, finish_reason),
            )
            row = int(cursor.lastrowid)
        finally:
            conn.close()
        self.rows.append({"id": row, "session_id": session_id, "role": role, "content": content,
                          "display_kind": display_kind, "display_metadata": display_metadata})
        return row


class RoutineMessage(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.store = db_path(self.home)
        self.state = self.home / "state.db"
        self._plant_state()
        chats.merge(self.store, {CHAT: {"at": 1, "value": {"hermesSessionId": SESSION, "title": "Main"}}})
        self.db = FakeStore(self.home)
        self.pushes = []
        patches = [
            mock.patch.dict(sys.modules, _host()),
            mock.patch.object(platform_gots, "current_path", lambda: self.store),
            mock.patch.object(platform_gots, "_store", lambda: self.db),
            mock.patch.object(platform_gots, "WAIT_SECONDS", 0),
            mock.patch.object(platform_gots.push, "notify",
                              lambda kind, session, path=None, title=None: self.pushes.append((kind, session))),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self._close_state)

    def _plant_state(self):
        conn = sqlite3.connect(self.state, isolation_level=None)
        conn.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT, source TEXT,
                model_config TEXT, started_at REAL, last_activity_at REAL, title TEXT
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
                timestamp REAL, display_kind TEXT, display_metadata TEXT, finish_reason TEXT
            );
            CREATE TABLE session_turn_leases (
                conversation_id TEXT PRIMARY KEY, holder TEXT, acquired_at REAL, expires_at REAL
            );
            """
        )
        conn.execute(
            "INSERT INTO sessions (id, started_at, last_activity_at, title) VALUES (?, ?, ?, ?)",
            (SESSION, time.time() - 86400, time.time() - 86400, "Main"),
        )
        conn.close()

    def _close_state(self):
        try:
            self.state.unlink()
        except OSError:
            pass

    # -- helpers ----------------------------------------------------------
    def _deliver(self, content=WRAPPED, metadata=None, media=None):
        return platform_gots.deliver("main", content, metadata or {}, media)

    def _runs(self):
        return platform_gots.routines(self.store, self.home, SESSION)

    def _rows(self):
        conn = sqlite3.connect(self.state)
        try:
            return conn.execute(
                "SELECT role, content, display_kind, display_metadata, finish_reason"
                " FROM messages ORDER BY id"
            ).fetchall()
        finally:
            conn.close()

    def _age(self, seconds):
        conn = sqlite3.connect(self.state, isolation_level=None)
        conn.execute("UPDATE sessions SET last_activity_at = ?", (time.time() - seconds,))
        conn.close()

    # -- registration -----------------------------------------------------
    def test_the_platform_is_registered_with_no_home_channel(self):
        ctx = mock.Mock()
        self.assertTrue(platform_gots.register(ctx))
        registered = ctx.register_platform.call_args.kwargs
        self.assertEqual(registered["name"], "gots")
        # The env var is declared and never set: a bare `deliver: gots` must fail loudly.
        self.assertEqual(registered["cron_deliver_env_var"], "GOTS_HOME_CHANNEL")
        self.assertNotIn("home_channel", registered)
        self.assertTrue(callable(registered["standalone_sender_fn"]))
        # A hint, never an authority: a parser makes cron strict and drops what it cannot parse.
        self.assertTrue(callable(registered["target_ref_syntax_fn"]))
        self.assertIsNone(registered.get("parse_target_ref_fn"))

    def test_the_adapter_cannot_promise_a_turn(self):
        adapter = platform_gots.adapter_factory(mock.Mock())
        self.assertFalse(adapter.supports_async_delivery)

    # -- the message ------------------------------------------------------
    def test_the_wrapper_never_reaches_the_thread(self):
        self._deliver()
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        content = rows[0][1]
        self.assertEqual(content, "The tide turns at 06:40.")
        self.assertNotIn("Cronjob Response", content)
        self.assertNotIn("job_id", content)
        self.assertNotIn("To stop or manage", content)

    def test_the_message_is_the_bots_own_row(self):
        self._deliver()
        role, content, kind, metadata, stopped = self._rows()[0]
        self.assertEqual(role, "assistant")
        self.assertEqual(kind, "routine_message")
        # A finished reply, as far as the app's fold is concerned: a row with no finish reason reads
        # as one still streaming, so the thread would sit "working" until the next turn.
        self.assertEqual(stopped, "stop")
        self.assertEqual(self._runs()[0]["job_id"], "job-1")

    def test_a_chat_is_named_by_main_or_by_its_own_id(self):
        self.assertEqual(platform_gots.resolve_chat(self.store, "main")["session"], SESSION)
        self.assertEqual(platform_gots.resolve_chat(self.store, CHAT)["session"], SESSION)
        self.assertIsNone(platform_gots.resolve_chat(self.store, "somewhere-else"))
        refused = platform_gots.deliver("somewhere-else", "hi", {}, [])
        self.assertIn("error", refused)
        self.assertEqual(self._rows(), [])

    def test_the_run_is_the_jobs_newest_session(self):
        self.db.runs = [{"id": "cron_job-1_99", "cron_job_id": "job-1"}]
        self._deliver()
        routine = self._runs()[0]
        self.assertEqual(routine["run_session"], "cron_job-1_99")
        self.assertEqual(routine["title"], "Morning watch")

    def test_the_card_is_told_what_ran_and_how_long_it_took(self):
        # The card says "Ran for 12s · claude-sonnet-4-5", and both come from the run's own session
        # row — the same row the session id does, so nothing extra is read.
        self.db.runs = [
            {
                "id": "cron_job-1_99",
                "cron_job_id": "job-1",
                "model": "claude-sonnet-4-5",
                "started_at": 1_760_000_000.0,
                "ended_at": 1_760_000_012.0,
            }
        ]
        self._deliver()
        routine = self._runs()[0]
        self.assertEqual(routine["model"], "claude-sonnet-4-5")
        self.assertEqual(routine["seconds"], 12.0)

    def test_the_model_is_named_with_the_provider_that_billed_it(self):
        self.db.runs = [
            {
                "id": "cron_job-1_99",
                "cron_job_id": "job-1",
                "model": "claude-sonnet-4-5",
                "billing_provider": "anthropic",
                "started_at": 1_760_000_000.0,
                "ended_at": 1_760_000_012.0,
            }
        ]
        self._deliver()
        self.assertEqual(self._runs()[0]["model"], "anthropic/claude-sonnet-4-5")

    def test_a_run_that_names_no_model_is_read_from_its_config(self):
        self.db.runs = [
            {
                "id": "cron_job-1_99",
                "cron_job_id": "job-1",
                "model_config": '{"model": "gpt-5-mini"}',
                "started_at": 1_760_000_000.0,
                "ended_at": 1_760_000_090.0,
            }
        ]
        self._deliver()
        routine = self._runs()[0]
        self.assertEqual(routine["model"], "gpt-5-mini")
        self.assertEqual(routine["seconds"], 90.0)

    def test_a_run_with_no_end_says_nothing_about_its_length(self):
        self.db.runs = [{"id": "cron_job-1_99", "cron_job_id": "job-1", "started_at": 1_760_000_000.0}]
        self._deliver()
        routine = self._runs()[0]
        self.assertIsNone(routine["seconds"])
        self.assertIsNone(routine["model"])

    def test_the_scheduler_lane_attributes_from_the_wrapper(self):
        self.db.runs = [{"id": "cron_job-1_99", "cron_job_id": "job-1"}]
        platform_gots.deliver("main", WRAPPED, {}, [])
        self.assertEqual(self._runs()[0]["run_session"], "cron_job-1_99")

    def test_a_message_with_no_identity_carries_no_run(self):
        result = self._deliver(content="The tide turns at 06:40.")
        self.assertTrue(result["success"])
        self.assertIsNone(self._runs()[0]["run_session"])

    def test_a_replayed_delivery_writes_one_message(self):
        self.db.runs = [{"id": "cron_job-1_99", "cron_job_id": "job-1"}]
        self._deliver()
        again = self._deliver()
        self.assertTrue(again["success"])
        self.assertEqual(len(self._rows()), 1)

    def test_an_empty_delivery_writes_nothing(self):
        result = platform_gots.deliver("main", "", {"job_id": "job-1"}, [])
        self.assertTrue(result["success"])
        self.assertEqual(self._rows(), [])

    # -- the aside --------------------------------------------------------
    def test_a_quiet_chat_gets_no_aside(self):
        self._age(3600)
        self._deliver()
        self.assertEqual(self._rows()[0][1], "The tide turns at 06:40.")

    def test_a_chat_active_moments_ago_reads_as_an_aside(self):
        self._age(60)
        self._deliver()
        content = self._rows()[0][1]
        self.assertTrue(content.endswith("The tide turns at 06:40."))
        self.assertIn(content[: -len("The tide turns at 06:40.")], platform_gots.ASIDE_OPENERS)

    def test_a_chat_in_a_turn_reads_as_an_aside(self):
        self._age(3600)
        self.db.busy = False
        # A lease another writer holds is what a chat in a turn looks like.
        conn = sqlite3.connect(self.state, isolation_level=None)
        conn.execute(
            "INSERT INTO session_turn_leases (conversation_id, holder, acquired_at, expires_at)"
            " VALUES (?, 'a-turn', ?, ?)",
            (SESSION, time.time(), time.time() + 300),
        )
        conn.close()
        self.db.busy = True
        self._deliver()
        queued = platform_gots.queued(self.store)
        self.assertEqual(len(queued), 1)
        self.assertTrue(queued[0]["text"].endswith("The tide turns at 06:40."))
        self.assertIn(queued[0]["text"][: -len("The tide turns at 06:40.")], platform_gots.ASIDE_OPENERS)

    # -- the queue --------------------------------------------------------
    def test_a_busy_chat_queues_and_writes_once_when_free(self):
        self.db.busy = True
        result = self._deliver()
        self.assertTrue(result["queued"])
        self.assertEqual(self._rows(), [])
        self.assertEqual(len(platform_gots.queued(self.store)), 1)
        # The chat's turn ends: the message is written, once, and only then.
        self.db.busy = False
        self.assertEqual(platform_gots.write_queued(self.home, self.store), 1)
        self.assertEqual(platform_gots.write_queued(self.home, self.store), 0)
        self.assertEqual(len(self._rows()), 1)
        self.assertEqual(platform_gots.queued(self.store), [])

    def test_a_queued_message_keeps_the_words_it_was_taken_with(self):
        self.db.busy = True
        self._deliver()
        taken = platform_gots.queued(self.store)[0]["text"]
        self.db.busy = False
        platform_gots.write_queued(self.home, self.store)
        self.assertEqual(self._rows()[0][1], taken)

    # -- the files --------------------------------------------------------
    def test_a_delivery_stages_its_files_and_names_them(self):
        source = self.home / "chart.png"
        source.write_bytes(b"png")
        result = self._deliver(media=[(str(source), False)])
        self.assertTrue(result["success"])
        content = self._rows()[0][1]
        staged = platform_gots._media_paths(content)
        self.assertEqual(len(staged), 1)
        self.assertTrue(staged[0].startswith(str(self.home / "memento" / "attachments")))
        self.assertTrue(Path(staged[0]).is_file())

    def test_a_sixth_file_is_dropped_and_named(self):
        files = []
        for index in range(6):
            source = self.home / f"file{index}.txt"
            source.write_text("x")
            files.append((str(source), False))
        result = self._deliver(media=files)
        self.assertEqual(len(platform_gots._media_paths(self._rows()[0][1])), platform_gots.MAX_ATTACHMENTS)
        self.assertEqual(len(result["dropped"]), 1)

    def test_a_file_lands_on_the_message_the_adapter_wrote(self):
        # Two routines deliver into one chat, and Hermes hands the first delivery's file over after
        # the second message exists: the adapter names the delivery, so the file goes to its message.
        self.db.runs = [{"id": "cron_job-1_1", "cron_job_id": "job-1"}]
        first = platform_gots.deliver("main", WRAPPED, {"job_id": "job-1"}, [])
        self.db.runs = [{"id": "cron_job-2_1", "cron_job_id": "job-2"}]
        second = platform_gots.deliver(
            "main", "Cronjob Response: Night watch\n(job_id: job-2)\n---\n\nAll quiet.", {"job_id": "job-2"}, []
        )
        self.assertNotEqual(first["execution"], second["execution"])
        source = self.home / "chart.png"
        source.write_bytes(b"png")
        platform_gots.attach("main", str(source), first["execution"])
        rows = self._rows()
        self.assertEqual(len(platform_gots._media_paths(rows[0][1])), 1, "the file's own message carries it")
        self.assertEqual(platform_gots._media_paths(rows[1][1]), [], "not the newer one")

    def test_a_routine_with_no_files_names_none(self):
        self._deliver()
        self.assertEqual(platform_gots._media_paths(self._rows()[0][1]), [])

    # -- the push ---------------------------------------------------------
    def test_a_delivery_tells_the_device(self):
        self._deliver(metadata={"job_id": "job-1", "notify": True})
        self.assertEqual(self.pushes, [("routine_message", SESSION)])

    def test_a_silent_delivery_tells_no_one(self):
        self._deliver(metadata={"job_id": "job-1", "notify": False})
        self.assertEqual(self.pushes, [])

    # -- the route --------------------------------------------------------
    def test_the_route_resolves_the_row_a_compaction_moved(self):
        self.db.runs = [{"id": "cron_job-1_99", "cron_job_id": "job-1"}]
        self._deliver()
        written = self._rows()[0]
        self.assertEqual(platform_gots.routines(self.store, self.home, SESSION)[0]["row"], 1)
        # A compaction re-emits the carried row under a fresh id in a child session.
        conn = sqlite3.connect(self.state, isolation_level=None)
        conn.execute(
            "INSERT INTO sessions (id, parent_session_id, started_at) VALUES ('tip', ?, ?)",
            (SESSION, time.time()),
        )
        conn.execute("UPDATE sessions SET end_reason = 'compression' WHERE id = ?", (SESSION,))
        conn.execute(
            """INSERT INTO messages (session_id, role, content, timestamp, display_kind, display_metadata)
               VALUES ('tip', 'assistant', ?, ?, 'routine_message', ?)""",
            (written[1], time.time(), written[3]),
        )
        moved = int(conn.execute("SELECT MAX(id) FROM messages").fetchone()[0])
        conn.close()
        found = platform_gots.routines(self.store, self.home, SESSION)
        self.assertEqual([one["row"] for one in found], [moved])
        self.assertEqual(found[0]["run_session"], "cron_job-1_99")

    def test_a_chat_with_no_routine_messages_answers_nothing(self):
        self.assertEqual(platform_gots.routines(self.store, self.home, SESSION), [])

    # -- the model is told, and the default is filled ---------------------
    def test_the_section_says_where_a_routine_delivers(self):
        self.assertIn("deliver: gots:main", platform_gots.PROMPT)

    def test_deliver_is_filled_only_when_the_model_named_nothing(self):
        filled = platform_gots.fill_deliver(
            tool_name="cronjob",
            session_id=SESSION,
            args={"action": "create", "prompt": "watch"},
        )
        self.assertEqual(filled, {"action": "modify", "args": {"deliver": "gots:main", "attach_to_session": False}})
        kept = platform_gots.fill_deliver(
            tool_name="cronjob",
            session_id=SESSION,
            args={"action": "create", "deliver": "telegram:1", "attach_to_session": True},
        )
        self.assertIsNone(kept)

    def test_a_routine_asked_for_elsewhere_is_left_alone(self):
        # Asked for in another platform's chat, the routine belongs where it was asked for: sweeping
        # it into this bot's Main thread would be a delivery nobody here asked for.
        self.assertIsNone(
            platform_gots.fill_deliver(
                tool_name="cronjob",
                session_id="telegram-42",
                args={"action": "create", "prompt": "watch"},
            )
        )
        self.assertIsNone(platform_gots.fill_deliver(tool_name="cronjob", args={"action": "create"}))

    def test_a_gots_job_never_mirrors_itself_into_the_chat(self):
        named = platform_gots.fill_deliver(
            tool_name="cronjob",
            session_id=SESSION,
            args={"action": "create", "deliver": "gots:main", "attach_to_session": True},
        )
        self.assertEqual(named, {"action": "modify", "args": {"attach_to_session": False}})

    def test_nothing_else_is_rewritten(self):
        self.assertIsNone(platform_gots.fill_deliver(tool_name="terminal", args={"command": "ls"}))
        self.assertIsNone(
            platform_gots.fill_deliver(tool_name="cronjob", session_id=SESSION, args={"action": "list"})
        )
        self.assertIsNone(
            platform_gots.fill_deliver(tool_name="cronjob", args={"action": "create", "deliver": "gots:main",
                                                                  "attach_to_session": False})
        )

    def test_a_host_without_a_session_store_says_so(self):
        # These tests import the plugin outside Hermes, which is exactly a host it can't write on.
        self.assertIsNotNone(platform_gots.available())
