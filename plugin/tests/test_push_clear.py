"""A dismissal told to every device: this profile's own subscriptions and topic, and the account's.

No push protocol removes a notification from another device, so the device that dismissed a subject
tells the account and every other device clears its own tray. This profile's web subscriptions and
its ntfy topic are told here; the account's Android installs are told through the registry, which an
approval answered from a notification's button reaches by way of the host, since a press carries no
key of the account's (ADR 0169).

Run: python3 -m unittest plugin.tests.test_push_clear -v
"""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

import plugin
from plugin import answers, chats, link, ntfy, push
from plugin.store import connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

BASE = "https://bot.example/api/plugins/gots"
ANSWER = plugin.PREFIX + "/push/answer/{token}"


def subscribed(path: Path, *devices: str) -> None:
    """A profile's push store with one subscription per device, all wanting a chat's news."""
    conn = connect(path)
    for index, device in enumerate(devices):
        conn.execute(
            "INSERT INTO push_subscriptions (endpoint, device, p256dh, auth, vapid_key, subject,"
            " created_at, categories) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                f"https://push.example/{index}",
                device,
                "key",
                "auth",
                "vapid",
                "mailto:a@b.c",
                1,
                '["chat_input"]',
            ),
        )
    conn.close()


class Dismiss(unittest.TestCase):
    """Who is told a subject is no news: every subscription but the one that asked."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))
        subscribed(self.path, "phone-1", "desktop-2")
        self.sent = []
        self.refused = ""
        sending = mock.patch.object(push, "send", self.answer)
        sending.start()
        self.addCleanup(sending.stop)

    def answer(self, row, payload, topic):
        self.sent.append((row["device"], payload))
        return 410 if row["device"] == self.refused else 201

    def devices(self):
        conn = connect(self.path)
        try:
            return [row[0] for row in conn.execute("SELECT device FROM push_subscriptions")]
        finally:
            conn.close()

    def test_every_subscription_but_the_one_that_asked_is_told(self):
        counts = push.dismiss(self.path, {"session_id": "gots-1", "device": "phone-1"})
        self.assertEqual(
            self.sent,
            [("desktop-2", {"kind": "clear", "session_id": "gots-1"})],
            "the phone that dismissed it closed its own entry already",
        )
        self.assertEqual(counts["cleared"], 1)

    def test_with_no_device_named_every_subscription_is_told(self):
        # An app on the web has no device in this profile's store, so it skips nothing.
        push.dismiss(self.path, {"session_id": "gots-1"})
        self.assertEqual([one[0] for one in self.sent], ["phone-1", "desktop-2"])

    def test_a_clear_has_a_topic_of_its_own_so_it_never_replaces_a_queued_notification(self):
        topics = []
        with mock.patch.object(
            push, "send", lambda row, payload, topic: topics.append(topic) or 201
        ):
            push.dismiss(self.path, {"session_id": "gots-1"})
        self.assertEqual(len(set(topics)), 1, "one topic for every clear of this subject")
        # A notification about the same thing rides the kind's own topic, so a clear collapses with
        # other clears and never stands in for one still queued at the push service.
        notice = push._b64(hashlib.sha256(b"approval:gots-1").digest()[:18])
        self.assertNotEqual(topics[0], notice)

    def test_a_subscription_the_service_dropped_is_forgotten(self):
        self.refused = "desktop-2"
        counts = push.dismiss(self.path, {"session_id": "gots-1"})
        self.assertEqual(counts["cleared"], 1, "the other subscription was told all the same")
        self.assertEqual(
            self.devices(),
            ["phone-1"],
            "a subscription the push service no longer knows goes, as a refused push takes it",
        )

    def test_a_body_that_names_no_subject_is_refused(self):
        for body in (
            {},
            {"session_id": ""},
            {"session_id": "x" * 201},
            {"session_id": 4},
            {"session_id": "gots-1", "device": "not a device"},
            {"session_id": "gots-1", "device": "d" * 65},
        ):
            with self.assertRaises(push.PushError, msg=repr(body)):
                push.dismiss(self.path, body)
        self.assertEqual(self.sent, [], "nothing was told")


class Schema(unittest.TestCase):
    """What a store already in use gains, and keeps, when the version moves."""

    def test_a_v75_store_gains_push_live_and_keeps_what_it_held(self):
        path = db_path(temp_hermes_home(self))
        old = connect(path)
        try:
            old.execute("INSERT INTO push_prefs (key, value) VALUES ('ntfy', '{}')")
            old.execute("PRAGMA user_version = 75")
        finally:
            old.close()
        connect(path).close()
        conn = sqlite3.connect(path)
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 77)
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertIn(
                "push_live",
                tables,
                "a store already in use reaches the table a dismissal reads",
            )
            self.assertIn(
                "canvas_builds",
                tables,
                "a store already in use reaches the table a canvas's builds are read from",
            )
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM push_prefs").fetchone()[0],
                1,
                "the rows it already held are left alone",
            )
        finally:
            conn.close()


class Ntfy(unittest.TestCase):
    """What the topic is told, and what a clear has to name to reach it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))
        self.env: Dict[str, str] = {}
        pool = types.ModuleType("agent.credential_pool")
        pool.get_env_prefer_dotenv = lambda key: self.env.get(key, "")
        agent = sys.modules.get("agent") or types.ModuleType("agent")
        for patcher in (
            mock.patch.dict(sys.modules, {"agent": agent, "agent.credential_pool": pool}),
            mock.patch.object(link, "set_env", lambda home, key, value: self.env.__setitem__(key, value)),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.env["NTFY_TOKEN"] = "tk_abc"
        ntfy.set_target(
            self.path, {"topic": "gots-Zk3", "categories": ["chat_input", "chat_run_done"]}
        )
        self.cleared = []
        clearing = mock.patch.object(
            ntfy, "publish_clear", lambda held, sequence: self.cleared.append(sequence) or 200
        )
        clearing.start()
        self.addCleanup(clearing.stop)

    def test_a_clear_names_every_category_the_subject_was_published_under(self):
        push.remember(self.path, "chat_input", "gots-1")
        push.remember(self.path, "chat_run_done", "gots-1")
        push.remember(self.path, "chat_input", "gots-2")
        counts = push.dismiss(self.path, {"session_id": "gots-1"})
        self.assertEqual(
            self.cleared,
            [
                ntfy.sequence_id("chat_input", "gots-1"),
                ntfy.sequence_id("chat_run_done", "gots-1"),
            ],
            "ntfy clears by the pair's own sequence id, and a dismissal names only the id",
        )
        self.assertEqual(counts["ntfy"], 2)
        self.assertEqual(push.outstanding(self.path, "gots-1"), [], "dismissed, so none left to name")
        self.assertEqual(push.outstanding(self.path, "gots-2"), ["chat_input"], "another's stays")

    def test_a_clear_no_server_took_keeps_what_it_did_not_clear(self):
        push.remember(self.path, "chat_input", "gots-1")
        refusing = mock.patch.object(ntfy, "publish_clear", lambda held, sequence: 500)
        refusing.start()
        self.addCleanup(refusing.stop)
        self.assertEqual(push.dismiss(self.path, {"session_id": "gots-1"})["ntfy"], 0)
        self.assertEqual(
            push.outstanding(self.path, "gots-1"),
            ["chat_input"],
            "a notification still showing is named again by the next dismissal",
        )

    def test_a_clear_about_what_was_never_published_names_nothing(self):
        self.assertEqual(push.dismiss(self.path, {"session_id": "nope"})["ntfy"], 0)
        self.assertEqual(self.cleared, [])

    def test_a_row_nobody_dismissed_is_dropped_once_it_is_old(self):
        push.remember(self.path, "chat_input", "gots-1")
        conn = connect(self.path)
        try:
            conn.execute("UPDATE push_live SET at = 1")
        finally:
            conn.close()
        self.assertEqual(push.outstanding(self.path, "gots-1"), [])

    def test_a_publish_that_lands_is_what_a_clear_reads(self):
        for patcher in (
            mock.patch.object(ntfy, "publish", lambda held, body, extra=None: 200),
            mock.patch.object(push, "_relay", lambda *args, **kwargs: None),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        push._deliver(self.path, "run_done", "chat_run_done", "gots-1")
        self.assertEqual(push.outstanding(self.path, "gots-1"), ["chat_run_done"])


class Answered(unittest.TestCase):
    """An approval settled on this host is no news on any device (ADR 0169)."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)
        push.set_base(self.path, BASE)
        subscribed(self.path, "desktop-2")
        self.state = {"token": "mh_x", "site": "https://app.example"}
        for patcher in (
            mock.patch.object(link, "load_state", lambda home: self.state),
            mock.patch.object(answers, "answer_run", lambda run_id, choice: 1),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.sent = []

    def press(self, url: str, body: Any = None) -> Dict[str, Any]:
        token = url.rsplit("/", 1)[-1]
        request = FakeWeb.Request()
        request.headers = {}
        request.match_info = {"token": token}
        request.query = {}
        request.path = ANSWER.replace("{token}", token)
        request.json = mock.AsyncMock(return_value=body or {})
        return asyncio.run(route(self.app, ANSWER, "POST")(request))

    def answering(self):
        """The patchers a dismissal leaves its records under: the web pushes it sent, and what it
        told the registry. They are started by the test and undone with it, since a dismissal runs
        on a thread of its own that outlives the press that started it."""
        bodies = []

        def call(site, method, route_name, **kwargs):
            bodies.append((method, route_name, kwargs.get("body")))
            return {}

        def send(row, payload, topic):
            # The web push goes first, linked or not, so it is what a test waits on.
            self.sent.append(payload)
            return 201

        sending = mock.patch.object(push, "send", send)
        calling = mock.patch.object(link, "call", call)
        return sending, calling, bodies

    def until(self, ready, what: str) -> None:
        """A dismissal runs on a thread of its own, so what it left behind is waited for."""
        deadline = time.monotonic() + 5
        while not ready() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(ready(), what)

    def test_an_answered_approval_is_dismissed_everywhere(self):
        buttons = answers.mint(
            self.path, answers.run_target("run_1", "gots-1"), BASE, push.TTL_SECONDS
        )
        sending, calling, bodies = self.answering()
        sending.start()
        calling.start()
        self.addCleanup(sending.stop)
        self.addCleanup(calling.stop)
        answered = self.press(buttons[0].url)
        self.assertEqual(answered["status"], 200, answered)
        self.until(lambda: bool(bodies), "the registry was told")
        self.assertEqual(self.sent, [{"kind": "clear", "session_id": "gots-1"}])
        self.assertEqual(
            bodies,
            [("POST", "push/dismiss", {"session_id": "gots-1"})],
            "the run's own session, told to the registry for the account's phones",
        )

    def test_an_answered_room_approval_is_dismissed_under_the_rooms_own_id(self):
        buttons = answers.mint(
            self.path,
            answers.room_target("room-1", {"kind": "approval"}),
            BASE,
            push.TTL_SECONDS,
        )
        sending, calling, bodies = self.answering()
        settling = mock.patch.object(answers, "answer_room", lambda *args, **kwargs: {})
        sending.start()
        calling.start()
        settling.start()
        for patcher in (sending, calling, settling):
            self.addCleanup(patcher.stop)
        answered = self.press(buttons[0].url)
        self.assertEqual(answered["status"], 200, answered)
        self.until(lambda: bool(bodies), "the registry was told")
        self.assertEqual(self.sent, [{"kind": "clear", "session_id": "room-1"}])
        self.assertEqual(bodies, [("POST", "push/dismiss", {"session_id": "room-1"})])

    def test_an_unlinked_profile_tells_only_its_own(self):
        buttons = answers.mint(
            self.path, answers.run_target("run_1", "gots-1"), BASE, push.TTL_SECONDS
        )
        unlinked = mock.patch.object(link, "load_state", lambda home: {})
        sending, calling, bodies = self.answering()
        unlinked.start()
        sending.start()
        calling.start()
        for patcher in (unlinked, sending, calling):
            self.addCleanup(patcher.stop)
        answered = self.press(buttons[0].url)
        self.assertEqual(answered["status"], 200, answered)
        self.until(lambda: bool(self.sent), "the web was told")
        self.assertEqual(self.sent, [{"kind": "clear", "session_id": "gots-1"}])
        self.assertEqual(bodies, [], "nothing to relay to: no registry to relay through")
