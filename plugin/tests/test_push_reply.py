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
import sys
import types
from pathlib import Path
from typing import Any, Dict, Optional
from unittest import mock

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

import plugin
from plugin import answers, chats, device_keys, link, notice, outbox, prompt_builder, push, sessions
from plugin.store import connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, js_constant, route, temp_hermes_home, wire

import unittest

BASE = "https://bot.example/api/plugins/gots"
REPLY = plugin.PREFIX + "/push/reply/{token}"
ANSWER = plugin.PREFIX + "/push/answer/{token}"
HERMES_TS = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "hermes.ts"
PINNED = {"provider": "anthropic", "model": "claude-sonnet-5"}
LINKED = {"token": "mh_x", "site": "https://app.example"}


class Phone:
    """A phone with its own P-256 key, as `NoticeKey.kt` makes one: it hands the public half to the
    plugin and signs each press it makes."""

    def __init__(self) -> None:
        self.private = ec.generate_private_key(ec.SECP256R1())
        self.der = self.private.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    @property
    def key(self) -> str:
        return push._b64(self.der)

    def headers(self, purpose: str, token: str, text: str = "") -> Dict[str, str]:
        signature = self.private.sign(device_keys.message(purpose, token, text), ec.ECDSA(hashes.SHA256()))
        return {"X-Gots-Key": device_keys.key_id(self.der), "X-Gots-Signature": push._b64(signature)}


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
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)
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
        # A phone that handed this profile its key, so the relay is minted links it can press.
        self.phone = Phone()
        device_keys.register(self.path, "phone-1", self.phone.key)

    def reply_of(self, kind: str = "run_done", session_id: str = "gots-1") -> Optional[str]:
        """The reply link one notice of ``kind`` would carry, or None."""
        return push._notice(self.path, kind, session_id, None, "Booked.", None).conversation.get("reply")

    def press(
        self, url: str, body: Any = None, at: str = REPLY, phone: Optional[Phone] = None, signed: bool = True
    ) -> Dict[str, Any]:
        """One press of a link, signed by this test's phone (or ``phone``) unless ``signed`` is False."""
        token = url.rsplit("/", 1)[-1]
        sent = {"text": "try again"} if body is None else body
        request = FakeWeb.Request()
        request.headers = {}
        if signed:
            purpose = device_keys.REPLY if at == REPLY else device_keys.ANSWER
            text = sent.get("text") if purpose == device_keys.REPLY and isinstance(sent, dict) else ""
            request.headers = (phone or self.phone).headers(purpose, token, text if isinstance(text, str) else "")
        request.match_info = {"token": token}
        request.query = {}
        request.path = at.replace("{token}", token)
        request.json = mock.AsyncMock(return_value=sent)
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

    def test_a_reply_that_was_spent_expired_or_refused_tells_the_entry_so(self) -> None:
        # The tray reads each refusal's status and its `error.message` (`ReplyOutcome.of` in the APK):
        # a spent or unknown link drops Reply, words the route won't take keep it.
        url = self.reply_of()
        words = self.press(url, {"text": " "})
        self.assertEqual((words["status"], words["payload"]["error"]["message"]), (400, "A reply needs some words."))
        self.assertEqual(self.press(url)["status"], 200)
        spent = self.press(url)
        self.assertEqual((spent["status"], spent["payload"]["error"]["message"]), (410, "That reply has already been sent."))
        unknown = self.press(url.rsplit("/", 1)[0] + "/not-a-token")
        self.assertEqual(unknown["status"], 404)
        self.assertEqual(unknown["payload"]["error"]["message"], "That reply isn't one this bot sent.")


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

    def relay(self, answer: Any) -> None:
        """One finished run told through the relay, the registry answering ``answer`` (or raising it)."""

        def call(*args: Any, **kwargs: Any) -> Any:
            if isinstance(answer, Exception):
                raise answer
            return answer

        with mock.patch.object(link, "call", call), mock.patch.object(push, "_rows", lambda path: []):
            push._run(self.path, "run_done", "gots-1", body="Booked.")

    def test_a_relay_no_phone_received_leaves_no_live_reply_link(self) -> None:
        # Every device skipped as on screen, or none that wants the category: the registry sent none.
        self.relay({"sent": 0, "failed": 0, "skipped": 1, "muted": 0})
        self.assertEqual(reply_rows(self.path), [], "a link no phone holds is given back")

    def test_a_relay_that_failed_leaves_no_live_reply_link(self) -> None:
        self.relay(link.LinkError("Push isn't set up on this site", 503))
        self.assertEqual(reply_rows(self.path), [])

    def test_a_relay_a_phone_received_keeps_its_reply_link(self) -> None:
        self.relay({"sent": 1, "failed": 0, "skipped": 0, "muted": 0})
        self.assertEqual(len(reply_rows(self.path)), 1, "the phone that got it can still press it")

    def test_a_closed_chat_mints_no_reply(self) -> None:
        chats.merge(
            self.path,
            {"chat-1": {"at": 2, "value": {"title": "Trip", "hermesSessionId": "gots-1", "discardedAt": 5}}},
        )
        self.assertIsNone(self.reply_of())

    def test_a_reply_link_outlives_the_push(self) -> None:
        self.assertEqual(answers.REPLY_SECONDS, 24 * 3600)
        self.assertGreater(answers.REPLY_SECONDS, push.TTL_SECONDS)


class FakeAiohttp:
    """Just enough of aiohttp for ``outbox.post``: it records where a run was posted and with what."""

    def __init__(self) -> None:
        self.posts: list = []
        fake = self

        class Response:
            status = 200

            async def json(self, content_type: Any = None) -> Dict[str, Any]:
                return {"run_id": "run_1"}

            async def __aenter__(self) -> "Response":
                return self

            async def __aexit__(self, *exc: Any) -> None:
                return None

        class ClientSession:
            def __init__(self, timeout: Any = None) -> None:
                pass

            async def __aenter__(self) -> "ClientSession":
                return self

            async def __aexit__(self, *exc: Any) -> None:
                return None

            def post(self, url: str, json: Any = None, headers: Any = None) -> Response:
                fake.posts.append((url, dict(headers or {}), json))
                return Response()

        self.module = types.ModuleType("aiohttp")
        self.module.ClientSession = ClientSession  # type: ignore[attr-defined]
        self.module.ClientTimeout = lambda total=None: None  # type: ignore[attr-defined]


class AProfileBot(Tray):
    """A bot served at /p/work: the app never posted from it, so the plugin knows no key of the app's."""

    def test_a_reply_for_a_profile_bot_posts_on_its_prefix_with_its_homes_key(self) -> None:
        (self.home / ".env").write_text("API_SERVER_KEY=workkey\n", encoding="utf-8")
        url = self.reply_of()
        with mock.patch.object(plugin, "_request_profile", lambda: "work"):
            self.assertEqual(self.press(url)["status"], 200)
        self.watch.assert_called_once()
        self.assertEqual(self.watch.call_args.args[:2], ("gots-1", "work"), "watched as the profile's")

        adapter = types.SimpleNamespace(_host="0.0.0.0", _port=8642, _api_key="launchkey", _run_statuses={})
        web = FakeAiohttp()
        with mock.patch.dict(sys.modules, {"aiohttp": web.module}), mock.patch.dict(
            outbox._keys, {}, clear=True
        ), mock.patch.object(outbox, "session_ids", mock.AsyncMock(return_value={"gots-1"})):
            asyncio.run(outbox.tick(adapter, "gots-1", "work", self.path))
        self.assertEqual(len(web.posts), 1, "the queued reply was posted")
        posted, headers, run = web.posts[0]
        self.assertEqual(posted, "http://127.0.0.1:8642/p/work/v1/runs", "on the profile's own prefix")
        self.assertEqual(headers["Authorization"], "Bearer workkey", "with that home's key, never the launch one")
        self.assertEqual(run["input"], [{"role": "user", "content": "try again"}])


class TheHint(unittest.TestCase):
    def test_the_plugins_run_hint_is_the_apps(self) -> None:
        self.assertEqual(
            prompt_builder.PLAN_HINT,
            js_constant(HERMES_TS.read_text(encoding="utf-8"), "PLAN_HINT"),
            "a reply's turn is told what the app's own send tells it",
        )


if __name__ == "__main__":
    unittest.main()
