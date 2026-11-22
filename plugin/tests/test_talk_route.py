"""The app's one talk hand-over, and the front door the charm's turn comes in by.

``GET talk`` answers the app with where the charm calls, which bot it is and a token — the one answer
the token is ever in the clear in. ``POST talk/v1/turn`` is the charm's own route, and nothing past
this step's gate is built yet: a turn without this bot's token is refused here, in words the charm
can name.
"""

from __future__ import annotations

import asyncio
import json
import unittest

import plugin
from plugin import link, store, talk_tokens
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

BOT = "0123456789abcdef"
OTHER = "fedcba9876543210"


def linked(home, **fields):
    """This profile's link record, as claiming a code writes it: a host, a bot id and an address."""
    state = {"site": "https://app.example", "hostId": "host-1", "token": "host_token", "botId": BOT}
    link.save_state(home, {**state, **fields})


class TalkRoute(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.app = wire(self, RouteAdapter())
        self.store = store.db_path(self.home)

    def call(self, path: str = "/talk", method: str = "GET", query=None, headers=None):
        request = FakeWeb.Request()
        request.match_info = {}
        request.headers = {"Host": "bot.example", **(headers or {})}
        request.scheme = "https"
        request.path = plugin.PREFIX + path
        request.query = query or {}
        return asyncio.run(route(self.app, plugin.PREFIX + path, method)(request))

    def test_the_app_is_answered_the_host_and_the_token(self) -> None:
        linked(self.home)
        answer = self.call()
        self.assertEqual(answer["status"], 200, answer)
        payload = answer["payload"]
        self.assertEqual(payload["object"], "gots.talk")
        self.assertEqual(
            payload["host"],
            "https://bot.example/api/plugins/gots",
            "the address the app dialled, which the charm appends /talk/v1/turn to",
        )
        self.assertEqual(payload["bot"], BOT, "the id the charm knows this bot by")
        self.assertTrue(
            talk_tokens.verify(self.store, BOT, payload["token"]),
            "the token the app is handed is the one the charm's turn will be judged by",
        )

    def test_the_token_is_kept_as_its_hash_and_answered_once(self) -> None:
        linked(self.home)
        first = self.call()["payload"]["token"]
        held = store.get_setting(self.store, f"{talk_tokens.SETTING}:{BOT}")
        self.assertNotIn(first, json.dumps(held), "a secret echoed is a secret with two copies")
        second = self.call()["payload"]["token"]
        self.assertNotEqual(first, second, "asking again is provisioning again, which mints anew")
        self.assertFalse(talk_tokens.verify(self.store, BOT, first))
        self.assertTrue(talk_tokens.verify(self.store, BOT, second))

    def test_the_token_is_never_echoed_by_any_other_answer(self) -> None:
        linked(self.home)
        token = self.call()["payload"]["token"]
        info = asyncio.run(route(self.app, plugin.PREFIX + "/info")(self.request("/info")))
        self.assertNotIn(token, json.dumps(info["payload"]))

    def request(self, path: str):
        request = FakeWeb.Request()
        request.match_info, request.headers, request.query = {}, {}, {}
        request.path = plugin.PREFIX + path
        return request

    def test_a_bot_this_host_does_not_serve_is_refused(self) -> None:
        linked(self.home)
        answer = self.call(query={"bot": OTHER})
        self.assertEqual(answer["status"], 404)
        self.assertEqual(answer["payload"]["error"]["message"], "No such bot.")

    def test_a_bot_id_that_is_not_one_is_refused(self) -> None:
        linked(self.home)
        answer = self.call(query={"bot": "not a bot"})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"]["error"]["message"], "Not a bot id")

    def test_a_bot_that_is_not_linked_says_so(self) -> None:
        answer = self.call()
        self.assertEqual(answer["status"], 409)
        self.assertIn("linked", answer["payload"]["error"]["message"])

    def test_the_info_route_advertises_talk(self) -> None:
        linked(self.home)
        info = asyncio.run(route(self.app, plugin.PREFIX + "/info")(self.request("/info")))
        self.assertIn("talk", info["payload"]["features"], "the row is drawn only where a host says so")

    def test_a_wrong_token_is_refused_by_the_turn_route(self) -> None:
        linked(self.home)
        good = self.call()["payload"]["token"]
        for headers in ({}, {"Authorization": "Bearer " + "0" * 64}, {"Authorization": good}):
            with self.subTest(headers=headers):
                answer = self.call("/talk/v1/turn", "POST", headers=headers)
                self.assertEqual(answer["status"], 401, answer)
        allowed = self.call("/talk/v1/turn", "POST", headers={"Authorization": f"Bearer {good}"})
        self.assertNotIn(allowed["status"], (401, 403), "this bot's own token is let past the gate")


if __name__ == "__main__":
    unittest.main()
