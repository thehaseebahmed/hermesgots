"""ntfy as a transport for the app's own news: what is kept, what is refused and what is published.

The server and the token are Hermes's own ``NTFY_SERVER_URL`` and ``NTFY_TOKEN``, read through its
credential helper; the tests plant that helper over a dict standing for the profile's environment.

Run: python3 -m unittest plugin.tests.test_ntfy -v
"""

from __future__ import annotations

import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import link, ntfy, push
from plugin.store import db_path


class Env(unittest.TestCase):
    """A profile whose environment is ``self.env``, read and written as Hermes would."""

    def setUp(self):
        self.path = db_path(Path(tempfile.mkdtemp()))
        self.env = {}
        pool = types.ModuleType("agent.credential_pool")
        pool.get_env_prefer_dotenv = lambda key: self.env.get(key, "")
        agent = sys.modules.get("agent") or types.ModuleType("agent")
        patches = [
            mock.patch.dict(sys.modules, {"agent": agent, "agent.credential_pool": pool}),
            mock.patch.object(link, "set_env", lambda home, key, value: self.env.__setitem__(key, value)),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)


TARGET = {"topic": "gots-Zk3", "device": "phone-1"}


class Target(Env):
    def test_the_server_and_token_are_hermes_own_and_only_the_topic_is_kept_here(self):
        self.env.update(NTFY_SERVER_URL="https://ntfy.example.com/", NTFY_TOKEN="tk_abc")
        ntfy.set_target(self.path, {**TARGET, "categories": ["chat_input"]})
        self.assertEqual(set(ntfy.stored(self.path)) - {"devices", "categories"}, {"topic"})
        answer = ntfy.public(ntfy.held(self.path), "phone-1")
        self.assertNotIn("tk_abc", repr(answer), "a token is never read back")
        self.assertEqual(
            {k: answer[k] for k in ("configured", "server", "server_set", "topic", "token_set", "joined")},
            {
                "configured": True,
                "server": "https://ntfy.example.com",
                "server_set": True,
                "topic": "gots-Zk3",
                "token_set": True,
                "joined": True,
            },
        )

    def test_with_no_server_set_it_is_ntfy_sh_as_hermes_reads_it(self):
        self.env["NTFY_TOKEN"] = "tk_abc"
        ntfy.set_target(self.path, {"topic": "gots-Zk3"})
        answer = ntfy.public(ntfy.held(self.path))
        self.assertEqual((answer["server"], answer["server_set"]), ("https://ntfy.sh", False))
        self.assertEqual(ntfy.target(self.path)["server"], "https://ntfy.sh")

    def test_server_and_token_are_written_to_hermes_own_variables(self):
        ntfy.set_target(self.path, {"server": "http://192.168.1.5:2586/", "token": "tk_abc"})
        self.assertEqual(self.env, {"NTFY_SERVER_URL": "http://192.168.1.5:2586", "NTFY_TOKEN": "tk_abc"})
        ntfy.set_target(self.path, {"server": ""})
        self.assertEqual(self.env["NTFY_SERVER_URL"], "", "an empty server is the default one")
        self.assertEqual(self.env["NTFY_TOKEN"], "tk_abc", "the token is Hermes's: a server change keeps it")

    def test_no_token_means_nothing_publishes_so_the_token_is_required(self):
        ntfy.set_target(self.path, {"topic": "gots-Zk3"})
        self.assertIsNone(ntfy.target(self.path))
        self.assertFalse(ntfy.public(ntfy.held(self.path))["configured"])
        with self.assertRaisesRegex(push.PushError, "token first"):
            ntfy.set_target(self.path, {"device": "phone-1"})
        self.env["NTFY_TOKEN"] = "tk_abc"
        self.assertIsNotNone(ntfy.target(self.path))

    def test_the_topic_hermes_listens_on_is_refused(self):
        self.env.update(NTFY_TOPIC="hermes-in", NTFY_TOKEN="tk_abc")
        with self.assertRaisesRegex(push.PushError, "Hermes listens on"):
            ntfy.set_target(self.path, {"topic": "hermes-in"})
        self.assertEqual(ntfy.stored(self.path), {}, "a refused write keeps nothing")

    def test_a_refused_write_writes_no_variable_either(self):
        with self.assertRaises(push.PushError):
            ntfy.set_target(self.path, {"server": "https://ntfy.example.com", "topic": "a b"})
        self.assertEqual(self.env, {})

    def test_any_http_server_the_host_can_reach_is_taken(self):
        for server, kept in (
            ("http://ntfy.sh", "http://ntfy.sh"),
            ("https://localhost:8080/", "https://localhost:8080"),
            ("http://192.168.1.5", "http://192.168.1.5"),
            ("http://ntfy.lan:2586/prefix/", "http://ntfy.lan:2586/prefix"),
        ):
            ntfy.set_target(self.path, {"server": server})
            self.assertEqual(self.env["NTFY_SERVER_URL"], kept)

    def test_only_an_address_and_ntfys_own_topics_are_taken(self):
        for server in ("ftp://ntfy.sh", "ntfy.sh", "https://u:p@ntfy.sh", "https://ntfy.sh/?a=1", "https://", 7):
            with self.assertRaises(push.PushError, msg=str(server)):
                ntfy.set_target(self.path, {"server": server})
        for topic in ("", "has space", "a/b", "x" * 65, None):
            with self.assertRaises(push.PushError, msg=str(topic)):
                ntfy.set_target(self.path, {"topic": topic})
        with self.assertRaises(push.PushError):
            ntfy.set_target(self.path, {"token": "two words"})
        self.assertEqual(self.env, {})

    def test_a_phone_leaving_keeps_the_target_and_remove_keeps_hermes_variables(self):
        self.env["NTFY_TOKEN"] = "tk_abc"
        ntfy.set_target(self.path, TARGET)
        ntfy.set_target(self.path, {"device": "phone-2"})
        self.assertEqual(ntfy.remove(self.path, "phone-1")["devices"], ["phone-2"])
        self.assertIsNotNone(ntfy.target(self.path), "the target is the bot's, not its phones'")
        ntfy.remove(self.path, None)
        self.assertIsNone(ntfy.target(self.path))
        self.assertEqual(self.env, {"NTFY_TOKEN": "tk_abc"}, "Hermes's own token stays Hermes's")

    def test_a_user_pass_token_is_basic_as_hermes_sends_it(self):
        self.assertEqual(ntfy.auth_header("tk_abc"), {"Authorization": "Bearer tk_abc"})
        self.assertEqual(ntfy.auth_header(" alice:secret\n")["Authorization"], "Basic YWxpY2U6c2VjcmV0")
        self.assertEqual(ntfy.auth_header(""), {})


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


class Deliver(Env):
    def setUp(self):
        super().setUp()
        self.env["NTFY_TOKEN"] = "tk_abc"
        self.sent = []
        self.publishing = mock.patch.object(
            ntfy, "publish", lambda held, body: self.sent.append((held, body)) or 200
        )
        self.publishing.start()
        self.publish_on = True
        self.addCleanup(lambda: self.publish_on and self.publishing.stop())

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
        self.publishing.stop()
        self.publish_on = False
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


class BothTransports(Env):
    """One event, one notification: what stops ntfy and Firebase both telling the same phone."""

    def setUp(self):
        super().setUp()
        self.env["NTFY_TOKEN"] = "tk_abc"

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
