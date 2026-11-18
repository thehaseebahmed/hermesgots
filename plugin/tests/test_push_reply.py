"""A reply typed in the Android tray, sent as a message in that chat with the app closed.

A finished or failed run's notice carries one reply link where the profile is linked to the registry
(the only transport that can draw a reply) and the chat is still open. The link is a bearer credential
like an approval's button: it queues one turn of text on one chat, and nothing else. The route takes no
account key, redeems only a reply, and queues a turn the plugin builds itself — the text, the chat's
pinned model and the instructions the app's own send would carry — marked as the user sending again,
so a failed run's paused queue goes.

Run: python3 -m unittest plugin.tests.test_push_reply -v
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Dict, Optional
from unittest import mock

import plugin
from plugin import answers, chats, link, notice, outbox, prompt_builder, push, sessions
from plugin.store import connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, js_constant, route, temp_hermes_home, wire

import unittest

BASE = "https://bot.example/api/plugins/gots"
REPLY = plugin.PREFIX + "/push/reply/{token}"
ANSWER = plugin.PREFIX + "/push/answer/{token}"
HERMES_TS = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "hermes.ts"
PINNED = {"provider": "anthropic", "model": "claude-sonnet-5"}
LINKED = {"token": "mh_x", "site": "https://app.example"}


def reply_rows(path: Path) -> list:
    conn = connect(path)
    try:
        return conn.execute("SELECT choice FROM answer_tokens WHERE choice = 'reply'").fetchall()
    finally:
        conn.close()


class Tray(unittest.TestCase):
    """A linked profile that knows its own address, and one open chat with a pinned model."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.app = wire(self, RouteAdapter())
        push.set_base(self.path, BASE)
        chats.merge(
            self.path,
            {"chat-1": {"at": 1, "value": {"title": "Trip", "hermesSessionId": "gots-1", "modelChoice": PINNED}}},
        )
        self.state = dict(LINKED)
        for patcher in (
            mock.patch.object(link, "load_state", lambda home: self.state),
            mock.patch.object(outbox, "watch"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.watch = outbox.watch

    def reply_of(self, kind: str = "run_done", session_id: str = "gots-1") -> Optional[str]:
        """The reply link one notice of ``kind`` would carry, or None."""
        return push._notice(self.path, kind, session_id, None, "Booked.", None).conversation.get("reply")

    def press(self, url: str, body: Any = None, at: str = REPLY) -> Dict[str, Any]:
        token = url.rsplit("/", 1)[-1]
        request = FakeWeb.Request()
        request.headers = {}
        request.match_info = {"token": token}
        request.query = {}
        request.path = at.replace("{token}", token)
        request.json = mock.AsyncMock(return_value={"text": "try again"} if body is None else body)
        return asyncio.run(route(self.app, at, "POST")(request))


class AReply(Tray):
    def test_a_reply_queues_a_turn_on_the_chats_session_with_the_app_closed(self) -> None:
        url = self.reply_of()
        self.assertIsNotNone(url, "a finished run's notice carries a reply")
        self.assertTrue(url.startswith(BASE + answers.REPLY_PATH), url)
        answered = self.press(url)
        self.assertEqual(answered["status"], 200, answered)
        self.assertEqual(answered["payload"]["object"], "gots.push.reply")
        items = outbox.read(self.path, "gots-1")["items"]
        self.assertEqual([item["text"] for item in items], ["try again"])
        conn = connect(self.path)
        try:
            body = outbox.json.loads(conn.execute("SELECT body FROM outbox").fetchone()[0])
        finally:
            conn.close()
        self.assertEqual(
            body,
            {
                "input": [{"role": "user", "content": "try again"}],
                "model": PINNED["model"],
                "provider": PINNED["provider"],
                "instructions": prompt_builder.PLAN_HINT,
                "session_id": "gots-1",
            },
            "the turn the app's own send would start: the text, the pinned model and its hint",
        )
        # Watched with no key of the app's: the dispatcher posts with the home's own.
        self.watch.assert_called_once()
        self.assertEqual(self.watch.call_args.args[0], "gots-1")
        self.assertIsNone(self.watch.call_args.kwargs.get("authorization"))
        self.assertEqual(len(self.watch.call_args.args), 3)

    def test_a_project_sessions_reply_is_told_its_workspace(self) -> None:
        record = {"mode": "accept_edits", "repos": [{"name": "o/r", "path": "/w/r", "branch": "hermes/x"}]}
        url = self.reply_of()
        with mock.patch.object(sessions, "record_for", lambda path, home, session_id: record):
            self.assertEqual(self.press(url)["status"], 200)
        conn = connect(self.path)
        try:
            body = outbox.json.loads(conn.execute("SELECT body FROM outbox").fetchone()[0])
        finally:
            conn.close()
        self.assertEqual(
            body["instructions"],
            prompt_builder.PLAN_HINT + "\n" + prompt_builder.session_prompt(record),
        )

    def test_a_reply_after_a_failed_run_is_sent_not_paused(self) -> None:
        url = self.reply_of("run_failed")
        self.assertIsNotNone(url, "a failed run's notice carries a reply")
        failed = [{"status": "failed", "created_at": 1.0, "updated_at": 2.0}]
        self.assertEqual(outbox.state(failed, outbox.read(self.path, "gots-1")["resumed_at"]), "paused")
        self.assertEqual(self.press(url)["status"], 200)
        self.assertEqual(
            outbox.state(failed, outbox.read(self.path, "gots-1")["resumed_at"]),
            "idle",
            "a reply is the user sending again, so the queue the failure paused goes",
        )

    def test_a_reply_link_answers_nothing_but_a_reply(self) -> None:
        approval = answers.mint(
            self.path, answers.run_target("run_1", "gots-1"), BASE, push.TTL_SECONDS
        )
        self.assertEqual(self.press(approval[0].url)["status"], 404, "an approval's token is no reply")
        url = self.reply_of()
        self.assertEqual(self.press(url, at=ANSWER)["status"], 404, "a reply's token answers no approval")
        self.assertEqual(self.press(url)["status"], 200, "and it is still a reply, unspent")
        self.assertEqual(self.press(url)["status"], 410, "once")
        self.assertEqual(len(outbox.read(self.path, "gots-1")["items"]), 1)

    def test_a_reply_with_no_words_is_refused_and_spends_nothing(self) -> None:
        url = self.reply_of()
        for body in ({"text": "  "}, {"text": 3}, {}, {"text": "x" * (outbox.MAX_TEXT + 1)}):
            self.assertEqual(self.press(url, body)["status"], 400, body)
        self.assertEqual(self.press(url)["status"], 200, "the link was never spent")

    def test_a_reply_that_cannot_be_queued_gives_its_link_back(self) -> None:
        url = self.reply_of()
        with mock.patch.object(outbox, "add", side_effect=RuntimeError("disk")):
            with self.assertRaises(RuntimeError):
                self.press(url)
        self.assertEqual(self.press(url)["status"], 200, "pressable again")

    def test_a_reply_to_a_chat_closed_since_is_refused(self) -> None:
        url = self.reply_of()
        chats.merge(
            self.path,
            {"chat-1": {"at": 2, "value": {"title": "Trip", "hermesSessionId": "gots-1", "resolvedAt": 5}}},
        )
        self.assertEqual(self.press(url)["status"], 409)
        self.assertEqual(outbox.read(self.path, "gots-1")["items"], [])


class WhoGetsOne(Tray):
    def test_approvals_questions_plans_routines_and_rooms_mint_no_reply(self) -> None:
        for kind in notice.KINDS:
            minted = self.reply_of(kind)
            if kind in ("run_done", "run_failed"):
                self.assertIsNotNone(minted, kind)
            else:
                self.assertIsNone(minted, f"{kind} offers no reply")
        self.assertEqual(len(reply_rows(self.path)), 2, "a link is minted only where it is carried")

    def test_a_web_push_only_profile_mints_no_reply_link(self) -> None:
        self.state = {}
        self.assertIsNone(self.reply_of())
        self.assertEqual(reply_rows(self.path), [], "a credential nobody can press is never minted")

    def test_a_closed_chat_mints_no_reply(self) -> None:
        chats.merge(
            self.path,
            {"chat-1": {"at": 2, "value": {"title": "Trip", "hermesSessionId": "gots-1", "discardedAt": 5}}},
        )
        self.assertIsNone(self.reply_of())

    def test_a_reply_link_outlives_the_push(self) -> None:
        self.assertEqual(answers.REPLY_SECONDS, 24 * 3600)
        self.assertGreater(answers.REPLY_SECONDS, push.TTL_SECONDS)


class TheHint(unittest.TestCase):
    def test_the_plugins_run_hint_is_the_apps(self) -> None:
        self.assertEqual(
            prompt_builder.PLAN_HINT,
            js_constant(HERMES_TS.read_text(encoding="utf-8"), "PLAN_HINT"),
            "a reply's turn is told what the app's own send tells it",
        )


if __name__ == "__main__":
    unittest.main()
