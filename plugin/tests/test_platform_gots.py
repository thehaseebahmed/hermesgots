"""A routine's delivery is a row of the bot's chat list: one per run (G4).

The seams are Hermes's own: the adapter's ``send()`` with routing metadata, and the scheduler's
standalone sender with none. Hermes's session store is faked at the one method a delivery asks it —
the run ledger — and the plugin's store is a real file, so the row a delivery publishes is read back
the way the app reads it.

Run: python3 -m unittest plugin.tests.test_platform_gots -v
"""

from __future__ import annotations

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

JOB = "job-1"
RUN = "cron_job-1_99"
ROW = f"routine-{JOB}-{RUN}"
LINE = "The tide turns at 06:40."
WRAPPED = (
    "Cronjob Response: Morning watch\n"
    f"(job_id: {JOB})\n"
    "-------------\n\n"
    f"{LINE}\n\n"
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
    # The host's own routine list, which a delivery Hermes didn't wrap a name into reads.
    jobs = types.ModuleType("cron.jobs")
    jobs.list_jobs = lambda include_disabled=False: [{"id": JOB, "name": "Tide watch"}]
    cron = types.ModuleType("cron")
    cron.jobs = jobs
    return {
        "gateway": gateway,
        "gateway.config": config,
        "gateway.platforms": platforms,
        "gateway.platforms.base": base,
        "gateway.platforms.send_targets": send_targets,
        "cron": cron,
        "cron.jobs": jobs,
    }


class FakeStore:
    """Hermes's session store, at the boundary a delivery uses: the run ledger, and nothing else.

    It has no writer at all, which is the point: a delivery publishes a chat record, and the
    transcript is the run's own business.
    """

    def __init__(self, home: Path):
        self.home = home
        self.runs = []

    def list_cron_job_runs(self, job_id, limit=20):
        return [run for run in self.runs if run.get("cron_job_id") in (None, job_id)][:limit]


class RoutineRow(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.store = db_path(self.home)
        connect(self.store).close()
        self.db = FakeStore(self.home)
        self.pushes = []
        patches = [
            mock.patch.dict(sys.modules, _host()),
            mock.patch.object(platform_gots, "current_path", lambda: self.store),
            mock.patch.object(platform_gots, "_store", lambda: self.db),
            mock.patch.object(
                platform_gots.push,
                "notify",
                lambda kind, session, path=None, title=None: self.pushes.append((kind, session)),
            ),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    # -- helpers ----------------------------------------------------------
    def _deliver(self, ref="gots", content=WRAPPED, metadata=None):
        return platform_gots.deliver(ref, content, metadata or {}, [])

    def _records(self):
        return chats.read(self.store)

    def _one(self, row=ROW):
        return self._records()[row]["value"]

    def _forget(self, *rows):
        """Takes records out of the store, as a device that never heard of them."""
        conn = sqlite3.connect(self.store, isolation_level=None)
        try:
            for row in rows:
                conn.execute("DELETE FROM chats WHERE id = ?", (row,))
        finally:
            conn.close()

    def _runs(self, run=RUN):
        self.db.runs = [{"id": run, "cron_job_id": JOB}]

    # -- registration -----------------------------------------------------
    def test_the_platform_is_registered_for_a_bare_gots_delivery(self):
        ctx = mock.Mock()
        self.assertTrue(platform_gots.register(ctx))
        registered = ctx.register_platform.call_args.kwargs
        self.assertEqual(registered["name"], "gots")
        self.assertEqual(registered["cron_deliver_env_var"], "GOTS_HOME_CHANNEL")
        self.assertTrue(callable(registered["standalone_sender_fn"]))
        # A hint, never an authority: a parser makes cron strict and drops what it cannot parse.
        self.assertTrue(callable(registered["target_ref_syntax_fn"]))
        self.assertIsNone(registered.get("parse_target_ref_fn"))

    def test_register_names_the_channel_a_bare_delivery_resolves_to(self):
        platform_gots.register(mock.Mock())
        env = (self.home / ".env").read_text(encoding="utf-8")
        self.assertIn("GOTS_HOME_CHANNEL=gots", env)

    def test_the_channel_is_named_in_every_home_it_is_given(self):
        # A multiplexed host serves more than the profile it was launched as, and each home has its
        # own `.env`: a line written into one leaves every other profile's bare `gots` with no legal
        # target (`link.served_homes`, the list the wiring pass and `resume` both publish for).
        others = [Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())]
        failed = platform_gots.name_channel([self.home, *others])
        self.assertEqual(failed, [])
        for home in (self.home, *others):
            self.assertIn("GOTS_HOME_CHANNEL=gots", (home / ".env").read_text(encoding="utf-8"))

    def test_a_home_that_refuses_the_line_is_reported_and_the_rest_are_named(self):
        # A file that can't be written is not a reason to leave every other profile without a
        # channel, and it is not something to swallow either: the caller is told which homes missed
        # it, and the log names the file.
        broken = Path(tempfile.mkdtemp())
        (broken / ".env").mkdir()
        other = Path(tempfile.mkdtemp())
        with self.assertLogs("plugin.platform_gots", level="WARNING") as logs:
            failed = platform_gots.name_channel([broken, other])
        self.assertEqual(failed, [broken], "the home that refused it is answered, not dropped")
        self.assertIn("GOTS_HOME_CHANNEL=gots", (other / ".env").read_text(encoding="utf-8"))
        self.assertTrue(
            any("GOTS_HOME_CHANNEL" in line for line in logs.output), "and the file is named"
        )

    def test_the_adapter_cannot_promise_a_turn(self):
        adapter = platform_gots.adapter_factory(mock.Mock())
        self.assertFalse(adapter.supports_async_delivery)

    # -- one row per run --------------------------------------------------
    def test_a_delivery_publishes_one_row_for_its_run(self):
        self._runs()
        result = self._deliver()
        self.assertTrue(result["success"])
        records = self._records()
        self.assertEqual(list(records), [ROW])
        value = records[ROW]["value"]
        self.assertEqual(value["hermesSessionId"], RUN, "the row opens the run's own transcript")
        self.assertEqual(value["title"], "Morning watch")
        self.assertTrue(value["routine"], "the list draws it with the routine's icon")

    def test_the_row_carries_the_runs_line_and_its_time(self):
        self._runs()
        before = int(time.time() * 1000)
        self._deliver()
        value = self._one()
        self.assertEqual(value["line"], LINE)
        self.assertGreaterEqual(value["updatedAt"], before)
        self.assertEqual(value["updatedAt"], self._records()[ROW]["at"], "one clock, one row")

    def test_the_wrapper_never_reaches_the_line(self):
        self._runs()
        self._deliver()
        line = self._one()["line"]
        self.assertNotIn("Cronjob Response", line)
        self.assertNotIn("job_id", line)
        self.assertNotIn("To stop or manage", line)

    def test_a_repeat_delivery_of_one_execution_writes_nothing(self):
        self._runs()
        self._deliver()
        written = self._records()
        again = self._deliver()
        self.assertTrue(again["success"])
        self.assertEqual(self._records(), written, "the same execution is one row, unchanged")

    def test_a_row_the_reader_deleted_is_not_resurrected(self):
        self._runs()
        self._deliver()
        chats.tombstone(self.store, ROW)
        self._deliver()
        self.assertTrue(self._records()[ROW].get("deleted"), "a row they are done with stays gone")

    def test_a_silent_run_publishes_nothing(self):
        self._runs()
        result = self._deliver(content="")
        self.assertTrue(result["success"])
        self.assertEqual(self._records(), {})

    def test_a_stored_jobs_channel_still_delivers(self):
        # `deliver: gots:main` hands the adapter `main`, an older job a chat id, and a bare
        # `deliver: gots` the home channel: the ref is a channel, not an address, so none of them is
        # read and no stored job has to be rewritten.
        self._runs()
        for ref in ("gots", "main", "main-bot", "an-old-chat-id"):
            with self.subTest(ref=ref):
                self._forget(ROW)
                self._deliver(ref=ref)
                self.assertIn(ROW, self._records())

    def test_a_delivery_it_cannot_attribute_publishes_nothing(self):
        # No run in the ledger: the row would open nothing, so there is no row to publish.
        result = self._deliver()
        self.assertTrue(result["success"])
        self.assertEqual(self._records(), {})

    def test_a_delivery_with_no_job_at_all_publishes_nothing(self):
        self._runs()
        result = self._deliver(content=LINE)
        self.assertTrue(result["success"])
        self.assertEqual(self._records(), {})

    def test_the_row_wears_the_routines_own_name(self):
        # Hermes wraps a delivery with the job's name; a host that doesn't is asked for it instead.
        self._runs()
        self._deliver(content=LINE, metadata={"job_id": JOB})
        self.assertEqual(self._one()["title"], "Tide watch")

    def test_one_row_for_each_run_of_one_routine(self):
        self._runs("cron_job-1_1")
        self._deliver()
        self._runs("cron_job-1_2")
        self._deliver()
        self.assertEqual(
            sorted(self._records()),
            sorted([f"routine-{JOB}-cron_job-1_1", f"routine-{JOB}-cron_job-1_2"]),
        )

    # -- the boundary: a delivery an older plugin queued -------------------
    def _queue(self, job_id=JOB, run_session=RUN, text=LINE, at=1_760_000_000_000, notify=1):
        conn = sqlite3.connect(self.store, isolation_level=None)
        conn.executescript(
            """CREATE TABLE IF NOT EXISTS routine_messages (
                   execution TEXT PRIMARY KEY, session_id TEXT NOT NULL, chat_id TEXT NOT NULL,
                   job_id TEXT, title TEXT, run_session TEXT, text TEXT NOT NULL, at INTEGER NOT NULL,
                   row INTEGER, notify INTEGER NOT NULL DEFAULT 1, model TEXT, seconds REAL
               )"""
        )
        conn.execute(
            "INSERT INTO routine_messages (execution, session_id, chat_id, job_id, title, run_session,"
            " text, at, row, notify) VALUES (?, 'gots-main', 'main', ?, 'Morning watch', ?, ?, ?,"
            " NULL, ?)",
            (f"{job_id}:{run_session}", job_id, run_session, text, at, notify),
        )
        conn.close()

    def _tables(self):
        conn = sqlite3.connect(self.store)
        try:
            return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        finally:
            conn.close()

    def test_a_delivery_queued_by_an_older_plugin_is_published(self):
        self._queue()
        self.assertEqual(platform_gots.publish_waiting(self.home), 1)
        value = self._one()
        self.assertEqual(value["hermesSessionId"], RUN)
        self.assertEqual(value["title"], "Morning watch")
        self.assertEqual(value["line"], LINE)
        self.assertEqual(self._records()[ROW]["at"], 1_760_000_000_000, "its own delivery time, kept")

    def test_the_old_queue_is_dropped_once_it_is_published(self):
        self._queue()
        platform_gots.publish_waiting(self.home)
        self.assertNotIn("routine_messages", self._tables())

    def test_publishing_what_waited_twice_writes_one_row(self):
        self._queue()
        platform_gots.publish_waiting(self.home)
        written = self._records()
        self.assertEqual(platform_gots.publish_waiting(self.home), 0)
        self.assertEqual(self._records(), written)

    def test_a_home_with_no_store_has_nothing_to_publish(self):
        self.assertEqual(platform_gots.publish_waiting(Path(tempfile.mkdtemp())), 0)

    def test_a_delivery_published_at_the_upgrade_is_announced_like_a_live_one(self):
        # A row queued before the plugin upgraded reaches the app as a row like any other, so the
        # device is told about it the way a delivery landing now tells it — otherwise the first
        # anyone hears of that run is a list they happened to open.
        self._queue()
        platform_gots.publish_waiting(self.home)
        self.assertEqual(self.pushes, [(platform_gots.KIND, RUN)])

    def test_a_queued_row_stored_as_not_notifying_is_published_silently(self):
        self._queue(notify=0)
        self.assertEqual(platform_gots.publish_waiting(self.home), 1)
        self.assertEqual(self.pushes, [], "the queue said not to announce this one")

    def test_a_queued_row_nothing_can_publish_keeps_the_table_and_is_named(self):
        # A row with no routine, or no run, is one nothing can open: publishing it would be a row
        # whose chat is empty. It is kept — the table is the only place it exists — and said out
        # loud, rather than deleted along with the queue that held it.
        self._queue()
        self._queue(job_id=None, run_session="cron_job-1_98")
        self._queue(run_session=None, job_id="job-2")
        with self.assertLogs("plugin.platform_gots", level="WARNING") as logs:
            published = platform_gots.publish_waiting(self.home)
        self.assertEqual(published, 1, "the row that can be published still is")
        self.assertIn("routine_messages", self._tables(), "the queue is kept while a row is in it")
        self.assertEqual(len(logs.output), 2, "each row that could not be published is named")
        self.assertTrue(all("kept" in line for line in logs.output))

    # -- the push ---------------------------------------------------------
    def test_a_delivery_tells_the_device_about_the_run(self):
        self._runs()
        self._deliver(metadata={"job_id": JOB, "notify": True})
        self.assertEqual(self.pushes, [("routine_message", RUN)])

    def test_a_silent_delivery_tells_no_one(self):
        self._runs()
        self._deliver(metadata={"job_id": JOB, "notify": False})
        self.assertEqual(self.pushes, [])

    def test_a_repeat_delivery_tells_no_one_again(self):
        self._runs()
        self._deliver(metadata={"job_id": JOB, "notify": True})
        self.pushes.clear()
        self._deliver(metadata={"job_id": JOB, "notify": True})
        self.assertEqual(self.pushes, [], "a retry is not news")

    # -- the model is told, and the default is filled ---------------------
    def test_the_section_says_a_routine_delivers_to_gots(self):
        self.assertIn("deliver: gots", platform_gots.PROMPT)
        self.assertNotIn("gots:main", platform_gots.PROMPT)

    def _asked_in_a_chat(self):
        """A chat of this bot's, as the directive reads one: the record names its session."""
        chats.merge(
            self.store,
            {"gots-asked-here": {"at": 1, "value": {"hermesSessionId": "gots-asked-here"}}},
        )

    def test_deliver_is_filled_with_the_channel_only(self):
        self._asked_in_a_chat()
        filled = platform_gots.fill_deliver(
            tool_name="cronjob",
            session_id="gots-asked-here",
            args={"action": "create", "prompt": "watch"},
        )
        self.assertEqual(filled, {"action": "modify", "args": {"deliver": "gots", "attach_to_session": False}})
        kept = platform_gots.fill_deliver(
            tool_name="cronjob",
            session_id="gots-asked-here",
            args={"action": "create", "deliver": "telegram:1", "attach_to_session": True},
        )
        self.assertIsNone(kept)

    def test_a_gots_job_never_mirrors_itself_into_the_chat(self):
        self._asked_in_a_chat()
        named = platform_gots.fill_deliver(
            tool_name="cronjob",
            session_id="gots-asked-here",
            args={"action": "create", "deliver": "gots:main", "attach_to_session": True},
        )
        self.assertEqual(named, {"action": "modify", "args": {"attach_to_session": False}})

    def test_a_routine_asked_for_elsewhere_is_left_alone(self):
        self.assertIsNone(
            platform_gots.fill_deliver(
                tool_name="cronjob",
                session_id="telegram-42",
                args={"action": "create", "prompt": "watch"},
            )
        )
        self.assertIsNone(platform_gots.fill_deliver(tool_name="cronjob", args={"action": "create"}))

    def test_nothing_else_is_rewritten(self):
        self._asked_in_a_chat()
        self.assertIsNone(platform_gots.fill_deliver(tool_name="terminal", args={"command": "ls"}))
        self.assertIsNone(
            platform_gots.fill_deliver(
                tool_name="cronjob", session_id="gots-asked-here", args={"action": "list"}
            )
        )
        self.assertIsNone(
            platform_gots.fill_deliver(
                tool_name="cronjob",
                args={"action": "create", "deliver": "gots:main", "attach_to_session": False},
            )
        )
