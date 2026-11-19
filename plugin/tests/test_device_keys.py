"""A link the relay carries is pressed only by a phone this bot knows (ADR 0167).

The relay to Android goes through the Gots registry and Firebase in clear, so a reply link or an
approval's button riding it could be pressed by whoever relayed it. Each phone hands the plugin a
public key from its own Keystore over the bot's own key; a link minted for the relay is `signed`, and
its route takes a press only with a signature from one of those keys over the purpose, the token and
the text. A refused press spends nothing. The browser's buttons ride Web Push, which is encrypted to
the browser, and stay a press alone.

Run: python3 -m unittest plugin.tests.test_device_keys -v
"""

from __future__ import annotations

import asyncio
import re
import unittest
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

import plugin
from plugin import answers, approvals, device_keys, link, push
from plugin.tests._helpers import FakeWeb, route
from plugin.tests.test_push_reply import ANSWER, BASE, REPLY, Phone, Tray, reply_rows

NOTICE_SIGNATURE_KT = (
    Path(__file__).resolve().parents[2]
    / "app/android/app/src/main/java/dev/hermesgots/NoticeSignature.kt"
)


def der_of(private: Any) -> str:
    return push._b64(
        private.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    )


class Keys(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "gots.db"

    def test_a_phones_key_signs_what_it_names_and_nothing_else(self) -> None:
        phone = Phone()
        key_id = device_keys.register(self.path, "phone-1", phone.key)
        self.assertEqual(key_id, device_keys.key_id(phone.der))
        headers = phone.headers(device_keys.REPLY, "tok", "hello")
        verify = lambda purpose, token, text: device_keys.verify(  # noqa: E731
            self.path, headers["X-Gots-Key"], headers["X-Gots-Signature"], purpose, token, text
        )
        self.assertTrue(verify(device_keys.REPLY, "tok", "hello"))
        self.assertFalse(verify(device_keys.REPLY, "tok", "hello!"), "other words")
        self.assertFalse(verify(device_keys.REPLY, "other", "hello"), "another link")
        self.assertFalse(verify(device_keys.ANSWER, "tok", "hello"), "another purpose")

    def test_a_key_nobody_handed_over_signs_nothing(self) -> None:
        device_keys.register(self.path, "phone-1", Phone().key)
        stranger = Phone()
        headers = stranger.headers(device_keys.ANSWER, "tok")
        self.assertFalse(
            device_keys.verify(
                self.path, headers["X-Gots-Key"], headers["X-Gots-Signature"], device_keys.ANSWER, "tok"
            )
        )
        self.assertFalse(device_keys.verify(self.path, None, None, device_keys.ANSWER, "tok"))
        self.assertFalse(
            device_keys.verify(self.path, "zz", headers["X-Gots-Signature"], device_keys.ANSWER, "tok")
        )

    def test_only_a_p256_key_is_taken(self) -> None:
        for refused in (
            der_of(ec.generate_private_key(ec.SECP384R1())),
            der_of(rsa.generate_private_key(public_exponent=65537, key_size=2048)),
            "not base64 !!",
            push._b64(b"not a key"),
            None,
        ):
            with self.subTest(refused=str(refused)[:16]):
                with self.assertRaises(device_keys.DeviceKeyError):
                    device_keys.register(self.path, "phone-1", refused)
        with self.assertRaises(device_keys.DeviceKeyError):
            device_keys.register(self.path, "not a device!", Phone().key)
        self.assertFalse(device_keys.held(self.path))

    def test_a_devices_new_key_replaces_its_old_one_and_removal_forgets_it(self) -> None:
        old, new = Phone(), Phone()
        device_keys.register(self.path, "phone-1", old.key)
        device_keys.register(self.path, "phone-1", new.key)
        signed = old.headers(device_keys.ANSWER, "tok")
        self.assertFalse(
            device_keys.verify(
                self.path, signed["X-Gots-Key"], signed["X-Gots-Signature"], device_keys.ANSWER, "tok"
            ),
            "a reinstall's key replaces the one before it",
        )
        device_keys.remove(self.path, "phone-1")
        self.assertFalse(device_keys.held(self.path))

    def test_a_profile_holds_a_bounded_number_of_phones(self) -> None:
        with mock.patch.object(device_keys, "now_ms", side_effect=range(1, 100)):
            for n in range(device_keys.MAX_KEYS + 3):
                device_keys.register(self.path, f"phone-{n}", Phone().key)
        from plugin.store import connect

        conn = connect(self.path)
        try:
            devices = {row[0] for row in conn.execute("SELECT device FROM device_keys")}
        finally:
            conn.close()
        self.assertEqual(len(devices), device_keys.MAX_KEYS)
        self.assertNotIn("phone-0", devices, "the oldest go first")

    def test_the_phone_signs_the_message_the_plugin_checks(self) -> None:
        # `NoticeSignature.kt` builds the same bytes; its context is held equal here, since a drift would
        # refuse every press with no other sign.
        source = NOTICE_SIGNATURE_KT.read_text(encoding="utf-8")
        found = re.search(r'const val CONTEXT = "([^"]+)"', source)
        self.assertIsNotNone(found)
        self.assertEqual(found.group(1), device_keys.CONTEXT)
        self.assertEqual(device_keys.message("reply", "tok", "hi"), b"gots-notice-v1\nreply\ntok\nhi")


class TheRelaysLinks(Tray):
    """A linked profile whose phone handed it a key (`Tray` registers one)."""

    def test_a_reply_unsigned_or_signed_by_a_stranger_is_refused_and_spends_nothing(self) -> None:
        url = self.reply_of()
        self.assertIsNotNone(url)
        for refused in ({"signed": False}, {"phone": Phone()}):
            with self.subTest(**{k: str(v) for k, v in refused.items()}):
                answer = self.press(url, **refused)
                self.assertEqual(answer["status"], 403)
                self.assertIn("phone this bot knows", answer["payload"]["error"]["message"])
        self.watch.assert_not_called()
        self.assertEqual(self.press(url)["status"], 200, "the link was left for the phone that holds it")

    def test_a_signature_over_other_words_is_refused(self) -> None:
        url = self.reply_of()
        token = url.rsplit("/", 1)[-1]
        request = FakeWeb.Request()
        request.headers = self.phone.headers(device_keys.REPLY, token, "yes")
        request.match_info = {"token": token}
        request.query = {}
        request.path = REPLY.replace("{token}", token)
        request.json = mock.AsyncMock(return_value={"text": "delete everything"})
        answer = asyncio.run(route(self.app, REPLY, "POST")(request))
        self.assertEqual(answer["status"], 403, "a signature binds the words it was made over")

    def test_a_forgotten_phone_can_no_longer_press(self) -> None:
        url = self.reply_of()
        device_keys.remove(self.path, "phone-1")
        self.assertEqual(self.press(url)["status"], 403)

    def test_with_no_phone_key_the_relay_is_minted_no_link_at_all(self) -> None:
        device_keys.remove(self.path, "phone-1")
        self.assertIsNone(self.reply_of(), "no reply link")
        self.assertEqual(reply_rows(self.path), [])
        notice = push._notice(self.path, "approval", "gots-1", None, "rm", answers.run_target("run_1", "gots-1"))
        self.assertEqual(notice.conversation["actions"], [], "and the relay draws no button")
        self.assertEqual(
            [one.label for one in notice.actions], ["Allow once", "Deny"], "while the browser's stay"
        )

    def approval(self) -> Any:
        return push._notice(
            self.path, "approval", "gots-1", None, "rm", answers.run_target("run_1", "gots-1")
        )

    def test_the_relay_carries_a_signed_pair_of_its_own(self) -> None:
        notice = self.approval()
        relayed = [one["url"] for one in notice.conversation["actions"]]
        browser = [one.url for one in notice.actions]
        self.assertEqual([one["label"] for one in notice.conversation["actions"]], ["Allow once", "Deny"])
        self.assertFalse(set(relayed) & set(browser), "tokens of its own")
        self.assertTrue(all(answers.needs_signature(self.path, url.rsplit("/", 1)[-1]) for url in relayed))
        self.assertFalse(
            any(answers.needs_signature(self.path, url.rsplit("/", 1)[-1]) for url in browser),
            "the browser's ride Web Push, encrypted to the browser",
        )

    def test_a_relayed_button_answers_only_with_the_phones_signature(self) -> None:
        url = self.approval().conversation["actions"][0]["url"]
        with mock.patch.object(approvals, "resolve", return_value=1) as resolve:
            self.assertEqual(self.press(url, at=ANSWER, signed=False)["status"], 403)
            resolve.assert_not_called()
            answer = self.press(url, at=ANSWER)
        self.assertEqual(answer["status"], 200)
        resolve.assert_called_once_with("run_1", "once")

    def test_a_browsers_button_is_still_a_press_alone(self) -> None:
        url = self.approval().actions[0].url
        with mock.patch.object(approvals, "resolve", return_value=1):
            self.assertEqual(self.press(url, at=ANSWER, signed=False)["status"], 200)

    def test_buttons_the_relay_put_on_no_phone_are_withdrawn(self) -> None:
        notice = self.approval()
        with mock.patch.object(link, "call", return_value={"sent": 0, "skipped": 1}):
            push._relay(self.path, "approval", "chat_input", "gots-1", notice)
        for one in notice.conversation["actions"]:
            self.assertFalse(answers.needs_signature(self.path, one["url"].rsplit("/", 1)[-1]))
        with mock.patch.object(approvals, "resolve", return_value=1):
            self.assertEqual(self.press(notice.conversation["actions"][0]["url"], at=ANSWER)["status"], 404)

    def test_the_relay_body_carries_the_signed_pair_not_the_browsers(self) -> None:
        notice = self.approval()
        bodies: List[Dict[str, Any]] = []
        with mock.patch.object(
            link, "call", lambda *a, **k: bodies.append(k["body"]) or {"sent": 1}
        ):
            push._relay(self.path, "approval", "chat_input", "gots-1", notice)
        self.assertEqual(bodies[0]["actions"], notice.conversation["actions"])


class TheKeyRoute(Tray):
    def post(self, at: str, body: Any, headers: Dict[str, str]) -> Dict[str, Any]:
        request = FakeWeb.Request()
        request.headers = headers
        request.match_info = {}
        request.query = {}
        request.path = "/api/plugins/gots" + at
        request.json = mock.AsyncMock(return_value=body)
        return asyncio.run(route(self.app, plugin.PREFIX + at, "POST")(request))

    def test_a_phone_hands_its_key_over_with_the_bots_key_and_can_take_it_back(self) -> None:
        phone = Phone()
        auth = {"Host": "bot.example"}
        answer = self.post("/push/key", {"device": "phone-2", "key": phone.key}, auth)
        self.assertEqual(answer["status"], 200, answer)
        self.assertEqual(answer["payload"]["key_id"], device_keys.key_id(phone.der))
        self.assertEqual(push.base(self.path), "https://bot.example/api/plugins/gots", "and where it dialled")
        url = self.reply_of()
        self.assertEqual(self.press(url, phone=phone)["status"], 200)
        self.assertEqual(self.post("/push/key/remove", {"device": "phone-2"}, auth)["status"], 200)
        self.assertEqual(self.press(self.reply_of(), phone=phone)["status"], 403)

    def test_a_key_is_refused_without_the_bots_key(self) -> None:
        self.adapter.denied = FakeWeb.json_response({"error": "no"}, 401)
        answer = self.post("/push/key", {"device": "phone-2", "key": Phone().key}, {})
        self.assertEqual(answer["status"], 401)

    def test_a_key_that_is_not_one_is_refused_in_words(self) -> None:
        auth: Dict[str, str] = {}
        answer = self.post("/push/key", {"device": "phone-2", "key": "nope"}, auth)
        self.assertEqual(answer["status"], 400)


if __name__ == "__main__":
    unittest.main()
