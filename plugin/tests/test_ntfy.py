"""ntfy as a transport for the app's own news: what is kept, what is refused and what is published.

Run: python3 -m unittest plugin.tests.test_ntfy -v
"""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import link, ntfy, push
from plugin.store import db_path

TARGET = {"server": "https://ntfy.sh/", "topic": "gots-Zk3", "token": "tk_abc", "device": "phone-1"}


class Target(unittest.TestCase):
    def setUp(self):
        self.path = db_path(Path(tempfile.mkdtemp()))

    def test_a_target_is_kept_without_its_token_ever_being_read_back(self):
        held = ntfy.set_target(self.path, {**TARGET, "categories": ["chat_input"]})
        self.assertEqual(held["server"], "https://ntfy.sh", "the address it is published to")
        answer = ntfy.public(ntfy.target(self.path))
        self.assertNotIn("token", answer)
        self.assertNotIn("tk_abc", repr(answer))
        self.assertEqual(
            {k: answer[k] for k in ("configured", "server", "topic", "token_set", "categories", "devices")},
            {
                "configured": True,
                "server": "https://ntfy.sh",
                "topic": "gots-Zk3",
                "token_set": True,
                "categories": ["chat_input"],
                "devices": 1,
            },
        )

    def test_a_token_is_required(self):
        with self.assertRaisesRegex(push.PushError, "access token"):
            ntfy.set_target(self.path, {"server": "https://ntfy.sh", "topic": "gots-Zk3"})
        self.assertIsNone(ntfy.target(self.path), "a refused write keeps nothing")

    def test_a_second_write_to_the_same_topic_needs_no_token(self):
        ntfy.set_target(self.path, TARGET)
        held = ntfy.set_target(
            self.path,
            {"server": "https://ntfy.sh", "topic": "gots-Zk3", "device": "phone-2", "categories": []},
        )
        self.assertEqual(held["token"], "tk_abc")
        self.assertEqual(held["devices"], ["phone-1", "phone-2"])
        self.assertEqual(held["categories"], [])

    def test_another_topic_starts_over_and_needs_its_own_token(self):
        ntfy.set_target(self.path, TARGET)
        with self.assertRaises(push.PushError):
            ntfy.set_target(self.path, {"server": "https://ntfy.sh", "topic": "other"})
        held = ntfy.set_target(self.path, {**TARGET, "topic": "other", "device": "phone-2"})
        self.assertEqual(held["devices"], ["phone-2"], "the devices of the old topic didn't choose this one")

    def test_only_a_public_https_server_and_ntfys_own_topics_are_taken(self):
        for server in ("http://ntfy.sh", "https://localhost", "https://10.0.0.4", "https://ntfy.sh/?a=1", 7):
            with self.assertRaises(push.PushError, msg=str(server)):
                ntfy.set_target(self.path, {**TARGET, "server": server})
        for topic in ("", "has space", "a/b", "x" * 65, None):
            with self.assertRaises(push.PushError, msg=str(topic)):
                ntfy.set_target(self.path, {**TARGET, "topic": topic})
        with self.assertRaises(push.PushError):
            ntfy.set_target(self.path, {**TARGET, "token": "two words"})

    def test_the_target_goes_with_its_last_device(self):
        ntfy.set_target(self.path, TARGET)
        ntfy.set_target(self.path, {**TARGET, "device": "phone-2"})
        self.assertEqual(ntfy.remove(self.path, "phone-1")["devices"], ["phone-2"])
        self.assertIsNone(ntfy.remove(self.path, "phone-2"))
        self.assertIsNone(ntfy.target(self.path))
        self.assertEqual(ntfy.public(None), {"object": "gots.push_ntfy", "configured": False})


class Message(unittest.TestCase):
    HELD = {"server": "https://ntfy.sh", "topic": "t", "token": "tk", "priorities": {"chat_input": 4}}

    def test_a_message_says_what_a_push_says(self):
        body = ntfy.message(self.HELD, "question", "chat_input", "gots-1", {"title": "Fix the build"})
        self.assertEqual(body["topic"], "t")
        self.assertEqual(body["title"], "Fix the build")
        self.assertEqual(body["message"], "You have a question waiting")
        self.assertEqual(body["priority"], 4, "what waits on the user peeks")
        self.assertEqual(body["click"], "gots://open?kind=question&id=gots-1")
        self.assertRegex(body["sequence_id"], ntfy.TOPIC, "ntfy holds a sequence id to a topic's rule")

    def test_a_category_with_no_stated_importance_is_ntfys_default(self):
        body = ntfy.message(self.HELD, "run_failed", "chat_run_failed", "gots-1")
        self.assertEqual(body["priority"], 3)
        self.assertEqual(body["title"], "Gots")
        self.assertEqual(ntfy.message(self.HELD, "routine_failed", "routine_failed", "j")["title"], "A routine")

    def test_the_same_thing_twice_replaces_itself_and_another_thing_does_not(self):
        one = ntfy.message(self.HELD, "question", "chat_input", "gots-1")["sequence_id"]
        self.assertEqual(one, ntfy.message(self.HELD, "approval", "chat_input", "gots-1")["sequence_id"])
        self.assertNotEqual(one, ntfy.message(self.HELD, "question", "chat_input", "gots-2")["sequence_id"])

    def test_the_words_are_the_ones_every_other_transport_says(self):
        fcm = (Path(__file__).resolve().parents[2] / "app" / "netlify" / "lib" / "fcm.ts").read_text()
        said = dict(re.findall(r'(\w+): "([^"]*)"', re.search(r"const WORDS[^{]*\{(.*?)\n\}", fcm, re.S).group(1)))
        said.pop("test", None)
        self.assertEqual(ntfy.WORDS, said)
        self.assertEqual(tuple(ntfy.WORDS), push.KINDS)
        untitled = re.search(r"const UNTITLED[^{]*\{(.*?)\n\}", fcm, re.S).group(1)
        self.assertEqual(ntfy.UNTITLED, dict(re.findall(r'(\w+): "([^"]*)"', untitled)))


class Deliver(unittest.TestCase):
    def setUp(self):
        self.path = db_path(Path(tempfile.mkdtemp()))
        self.sent = []
        patch = mock.patch.object(ntfy, "publish", lambda held, body: self.sent.append((held, body)) or 200)
        patch.start()
        self.addCleanup(patch.stop)

    def test_nothing_is_published_without_a_target(self):
        self.assertIsNone(ntfy.deliver(self.path, "question", "chat_input", "gots-1"))
        self.assertEqual(self.sent, [])
        self.assertFalse(push.reachable(self.path))

    def test_a_category_switched_off_in_the_app_is_not_published(self):
        ntfy.set_target(self.path, {**TARGET, "categories": ["chat_input"]})
        self.assertTrue(push.reachable(self.path), "a topic is a device that could be told")
        ntfy.deliver(self.path, "run_done", "chat_run_done", "gots-1")
        self.assertEqual(self.sent, [])
        self.assertEqual(ntfy.deliver(self.path, "question", "chat_input", "gots-1"), 200)
        self.assertEqual(len(self.sent), 1)

    def test_a_topic_is_held_back_only_while_every_phone_on_it_has_the_app_open(self):
        ntfy.set_target(self.path, {**TARGET, "categories": ["chat_input"]})
        ntfy.set_target(self.path, {**TARGET, "device": "phone-2"})
        ntfy.deliver(self.path, "question", "chat_input", "gots-1", on_screen=["phone-1"])
        self.assertEqual(len(self.sent), 1, "the other phone is in a pocket")
        ntfy.deliver(self.path, "question", "chat_input", "gots-1", on_screen=["phone-1", "phone-2"])
        self.assertEqual(len(self.sent), 1, "both are looking")

    def test_the_request_carries_the_token_and_posts_json_to_the_servers_root(self):
        mock.patch.stopall()
        seen = {}

        class Answer:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def urlopen(request, timeout):
            seen.update(url=request.full_url, auth=request.get_header("Authorization"), method=request.get_method())
            return Answer()

        with mock.patch.object(ntfy.urllib.request, "urlopen", urlopen):
            self.assertEqual(ntfy.publish({"server": "https://ntfy.sh", "token": "tk_abc"}, {"topic": "t"}), 200)
        self.assertEqual(seen, {"url": "https://ntfy.sh/", "auth": "Bearer tk_abc", "method": "POST"})


class BothTransports(unittest.TestCase):
    """One event, one notification: what stops ntfy and Firebase both telling the same phone."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.path = db_path(self.home)

    def test_a_push_goes_to_ntfy_and_the_registry_is_told_to_skip_that_phone(self):
        ntfy.set_target(self.path, {**TARGET, "categories": ["chat_input"]})
        published, relayed = [], []
        with mock.patch.object(ntfy, "publish", lambda held, body: published.append(body) or 200), \
            mock.patch.object(link, "load_state", lambda home: {"token": "mh_x", "site": "https://app.example"}), \
            mock.patch.object(link, "call", lambda site, method, route, token=None, body=None: relayed.append(body) or {"sent": 0}):
            push._deliver(self.path, "question", "chat_input", "gots-1", {"title": "A chat"})
        self.assertEqual([body["title"] for body in published], ["A chat"])
        self.assertEqual(relayed[0]["skip"], ["phone-1"])

    def test_a_muted_bot_publishes_nothing_on_any_transport(self):
        ntfy.set_target(self.path, {**TARGET, "categories": ["chat_input"]})
        push.set_bot_muted(self.path, True)
        with mock.patch.object(ntfy, "publish") as publish:
            push._run(self.path, "room_input", "room-1", "A room")
        publish.assert_not_called()


if __name__ == "__main__":
    unittest.main()
